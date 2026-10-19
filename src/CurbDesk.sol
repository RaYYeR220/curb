// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {OracleAttestationConsumer} from "./oracle/OracleAttestation.sol";
import {IIntake} from "./interfaces/IIntake.sol";
import {ILaunchFactory} from "./interfaces/ILaunchFactory.sol";
import {ICurbHook} from "./interfaces/ICurbHook.sol";

/// @title The desk behind Curb's pools
/// @notice The contract that pays IMD for the CURB launch, receives the launch's share of LP fees
/// as its requester, owns every Curb hook it binds, and spends its treasury only on IMD work for
/// those pools: one oracle question per halt, and a post-mortem when it can afford both.
///
/// Custody is the point. The steward can start the one launch, bind a drill pool, rotate the Intake
/// or the oracle key behind a 48-hour timelock, and renounce. It cannot withdraw: no function here
/// moves IMD anywhere except into the Intake, for exactly the action's listed price.
contract CurbDesk is OracleAttestationConsumer {
    using SafeERC20 for IERC20;

    enum Kind {
        None,
        Launch,
        Drill
    }

    enum RequestState {
        None,
        Requested,
        Completed,
        Failed
    }

    struct Pool {
        Kind kind;
        uint64 launchNumber;
    }

    struct Proposal {
        address value;
        uint64 eta;
    }

    bytes32 public constant LAUNCH_OPEN = bytes32("launch.open@launch-1");
    bytes32 public constant ORACLE_REQUEST = bytes32("oracle.request@oracle-1");
    bytes32 public constant JOB_OPEN = bytes32("job.open@job-1");
    uint64 public constant TIMELOCK = 48 hours;

    IERC20 public immutable imd;
    ILaunchFactory public immutable factory;
    IIntake public intake;
    address public steward;

    mapping(address hook => Pool) public pools;
    address[] public hooks;
    uint64 public launchNumber;
    bool public launchBound;

    bytes32 public launchRequestId;
    RequestState public launchState;
    bytes32 public launchResultHash;
    string public launchUri;

    Proposal public intakeProposal;
    Proposal public signerProposal;

    error NotSteward();
    error NotTheIntake();
    error ZeroAddress();
    error AlreadyBound();
    error NotOurLaunch(uint64 launchNumber);
    error NotOurHook(address hook);
    error TreasuryShort(uint256 have, uint256 need);
    error Timelocked(uint64 eta);
    error NothingProposed();
    error UnknownRequest(bytes32 requestId);

    event LaunchRequested(bytes32 indexed requestId, uint256 price);
    event Bound(address indexed hook, Kind kind, uint64 launchNumber);
    event Funded(address indexed from, uint256 amount);
    event Proposed(bytes32 indexed what, address value, uint64 eta);
    event Executed(bytes32 indexed what, address value);
    event Renounced();
    event ResultDelivered(bytes32 indexed requestId, bytes32 resultHash, string uri);
    event RequestFailed(bytes32 indexed requestId, uint8 status, bytes32 reason);

    modifier onlySteward() {
        if (msg.sender != steward || msg.sender == address(0)) revert NotSteward();
        _;
    }

    modifier onlyIntake() {
        if (msg.sender != address(intake)) revert NotTheIntake();
        _;
    }

    constructor(IIntake intake_, IERC20 imd_, ILaunchFactory factory_, address oracleSigner_, address steward_)
        OracleAttestationConsumer(oracleSigner_)
    {
        if (
            address(intake_) == address(0) || address(imd_) == address(0) || address(factory_) == address(0)
                || steward_ == address(0)
        ) revert ZeroAddress();
        intake = intake_;
        imd = imd_;
        factory = factory_;
        steward = steward_;
    }

    // ---- the launch ----

    /// @notice Pays IMD's `launch.open` for the CURB launch. `body` is the request JSON, checked
    /// free at `POST /requests/check` before it is sent; the desk is its payer, requester and owner.
    function launch(bytes calldata body) external onlySteward returns (bytes32 requestId) {
        if (launchBound) revert AlreadyBound();
        uint256 price = _pay(LAUNCH_OPEN);
        requestId = intake.requestWithFailure(
            LAUNCH_OPEN,
            body,
            IIntake.Callback(address(this), this.onResult.selector),
            this.onRequestFailure.selector,
            address(imd),
            price
        );
        launchRequestId = requestId;
        launchState = RequestState.Requested;
        emit LaunchRequested(requestId, price);
    }

    /// @notice Binds the launched pool: the factory must name this desk as the launch's requester
    /// and the pool's hook must answer to it. Anyone may call it, once.
    function bind(uint64 n) external {
        (PoolKey memory key,,, address requester) = factory.positionOf(n);
        if (requester != address(this)) revert NotOurLaunch(n);
        address hook = address(key.hooks);
        if (ICurbHook(hook).owner() != address(this)) revert NotOurHook(hook);
        if (launchBound || pools[hook].kind != Kind.None) revert AlreadyBound();
        launchBound = true;
        launchNumber = n;
        _register(hook, Kind.Launch, n);
    }

    /// @notice Binds a drill pool the steward deployed on a Curb hook this desk owns.
    function bindDrill(address hook) external onlySteward {
        if (ICurbHook(hook).owner() != address(this)) revert NotOurHook(hook);
        if (pools[hook].kind != Kind.None) revert AlreadyBound();
        _register(hook, Kind.Drill, 0);
    }

    /// @notice Tops up the treasury. Anyone may.
    function fund(uint256 amount) external {
        imd.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    // ---- the Intake's callbacks ----

    /// @notice A job's result: the launch, or a post-mortem.
    function onResult(bytes32 requestId, bytes32 resultHash, string calldata uri) external onlyIntake {
        if (requestId == launchRequestId && requestId != bytes32(0)) {
            launchState = RequestState.Completed;
            launchResultHash = resultHash;
            launchUri = uri;
        } else {
            revert UnknownRequest(requestId);
        }
        emit ResultDelivered(requestId, resultHash, uri);
    }

    /// @notice A refused or failed request. Unsigned, so it only records what the Intake said.
    function onRequestFailure(bytes32 requestId, uint8 status, bytes32 reason, uint16, uint16, bytes calldata)
        external
        onlyIntake
    {
        if (requestId == launchRequestId && requestId != bytes32(0)) {
            launchState = RequestState.Failed;
        } else {
            revert UnknownRequest(requestId);
        }
        emit RequestFailed(requestId, status, reason);
    }

    // ---- the steward ----

    function proposeIntake(IIntake to) external onlySteward {
        if (address(to) == address(0)) revert ZeroAddress();
        intakeProposal = _propose("intake", address(to));
    }

    function executeIntake() external onlySteward {
        intake = IIntake(_execute(intakeProposal, "intake"));
        delete intakeProposal;
    }

    function proposeOracleSigner(address to) external onlySteward {
        if (to == address(0)) revert ZeroAddress();
        signerProposal = _propose("oracleSigner", to);
    }

    function executeOracleSigner() external onlySteward {
        _setOracleSigner(_execute(signerProposal, "oracleSigner"));
        delete signerProposal;
    }

    function renounce() external onlySteward {
        steward = address(0);
        emit Renounced();
    }

    // ---- internals ----

    /// @dev Approves the Intake for exactly one price of `action`, or reverts naming the shortfall.
    function _pay(bytes32 action) internal returns (uint256 price) {
        price = intake.priceOf(action, address(imd));
        uint256 have = imd.balanceOf(address(this));
        if (have < price) revert TreasuryShort(have, price);
        imd.forceApprove(address(intake), price);
    }

    function _register(address hook, Kind kind, uint64 n) internal {
        pools[hook] = Pool(kind, n);
        hooks.push(hook);
        emit Bound(hook, kind, n);
    }

    function _propose(bytes32 what, address value) internal returns (Proposal memory p) {
        p = Proposal(value, uint64(block.timestamp) + TIMELOCK);
        emit Proposed(what, value, p.eta);
    }

    function _execute(Proposal memory p, bytes32 what) internal returns (address) {
        if (p.value == address(0)) revert NothingProposed();
        if (block.timestamp < p.eta) revert Timelocked(p.eta);
        emit Executed(what, p.value);
        return p.value;
    }
}
