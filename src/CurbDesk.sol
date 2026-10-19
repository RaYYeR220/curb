// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {OracleAttestation, OracleAttestationConsumer} from "./oracle/OracleAttestation.sol";
import {OracleQuestion} from "./oracle/OracleQuestion.sol";
import {IIntake} from "./interfaces/IIntake.sol";
import {ILaunchFactory} from "./interfaces/ILaunchFactory.sol";
import {ICurbHook} from "./interfaces/ICurbHook.sol";
import {Breaker} from "./libraries/Breaker.sol";
import {L2Block} from "./libraries/L2Block.sol";

/// @title The desk behind Curb's pools
/// @notice The contract that pays IMD for the CURB launch, receives the launch's share of LP fees
/// as its requester, owns every Curb hook it binds, and spends its treasury only on IMD work for
/// those pools: one oracle question per halt, and a post-mortem when it can afford both.
///
/// A halt is the pool asking a question it cannot answer itself: did one actor drive this move?
/// The desk buys the fact, not the judgement. It asks the oracle which trader on the hook's own
/// `Trade` tape moved the most volume over the incident's blocks, and how much; the share against
/// the hook's on-chain total is arithmetic, and a fixed rule turns it into a verdict. The question
/// is written here from the hook's numbers alone, so no caller can put words in it, and its hash is
/// pinned, so only the answer to that question is ever acted on.
///
/// Custody is the point. The steward can start the one launch, bind it and a drill pool, rotate the
/// oracle key behind a 48-hour timelock, and renounce. It cannot withdraw: no function here moves
/// IMD anywhere except into IMD's Intake, fixed at deployment, for exactly the action's listed
/// price, and never more than `MAX_PRICE` per request whatever the list says.
contract CurbDesk is OracleAttestationConsumer, ReentrancyGuard {
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

    enum IncidentState {
        None,
        Filed,
        Answered,
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

    struct Incident {
        IncidentState state;
        Breaker.Verdict verdict;
        bool applied;
        uint16 shareBps;
        address leader;
        uint64 fromBlock;
        uint64 toBlock;
        bytes32 requestId;
        uint256 figure;
        uint256 total;
        bytes32 jobRequestId;
        string reportUri;
    }

    struct Pending {
        address hook;
        uint32 nonce;
        bytes32 questionHash;
    }

    struct IncidentRef {
        address hook;
        uint32 nonce;
    }

    bytes32 public constant LAUNCH_OPEN = bytes32("launch.open@launch-1");
    bytes32 public constant ORACLE_REQUEST = bytes32("oracle.request@oracle-1");
    bytes32 public constant JOB_OPEN = bytes32("job.open@job-1");
    uint64 public constant TIMELOCK = 48 hours;
    /// @notice The most one request may cost, twice IMD's price at deployment.
    uint256 public constant MAX_PRICE = 1 ether;

    /// @notice The panel each question asks for, and how many must agree.
    uint16 public constant PANEL_SIZE = 7;
    uint16 public constant QUORUM = 5;
    uint32 public constant VALID_FOR = 3600;
    /// @notice At most this share of the window's volume from the top trader reads as organic...
    uint16 public constant ORGANIC_MAX_BPS = 3000;
    /// @notice ...and at least this much as one actor's move.
    uint16 public constant CONCENTRATED_MIN_BPS = 6000;
    /// @notice How many L2 blocks the window must close behind the head: the oracle reads an
    /// absolute window once its last block is five deep, a few blocks after the ask lands.
    uint64 public constant MIN_DEPTH = 8;

    IIntake public immutable intake;
    IERC20 public immutable imd;
    ILaunchFactory public immutable factory;
    address public steward;

    mapping(address hook => Pool) public pools;
    address[] public hooks;
    uint64 public launchNumber;
    bool public launchBound;

    bytes32 public launchRequestId;
    RequestState public launchState;
    bytes32 public launchResultHash;
    string public launchUri;

    Proposal public signerProposal;

    mapping(address hook => mapping(uint32 nonce => Incident)) internal incidents;
    mapping(bytes32 requestId => Pending) public pending;
    mapping(bytes32 requestId => IncidentRef) public postMortems;

    error NotSteward();
    error NotTheIntake();
    error ZeroAddress();
    error AlreadyBound();
    error NotOurLaunch(uint64 launchNumber);
    error NotOurHook(address hook);
    error TreasuryShort(uint256 have, uint256 need);
    error PriceAboveCap(uint256 price, uint256 cap);
    error Timelocked(uint64 eta);
    error NothingProposed();
    error UnknownRequest(bytes32 requestId);
    error UnknownPool(address hook);
    error NotHalted();
    error AlreadyFiled(uint32 nonce);
    error WindowTooFresh(uint64 toBlock, uint64 head);
    error WrongQuestion(bytes32 asked, bytes32 answered);
    error PanelTooWeak(uint16 panelSize, uint16 agreed);
    error NotAnswered(uint32 nonce);
    error AlreadyCommissioned(uint32 nonce);

    event LaunchRequested(bytes32 indexed requestId, uint256 price);
    event Bound(address indexed hook, Kind kind, uint64 launchNumber);
    event Funded(address indexed from, uint256 amount);
    event Proposed(bytes32 indexed what, address value, uint64 eta);
    event Executed(bytes32 indexed what, address value);
    event Renounced();
    event ResultDelivered(bytes32 indexed requestId, bytes32 resultHash, string uri);
    event RequestFailed(bytes32 indexed requestId, uint8 status, bytes32 reason);
    event IncidentFiled(
        address indexed hook,
        uint32 indexed nonce,
        bytes32 requestId,
        bytes32 questionHash,
        uint64 fromBlock,
        uint64 toBlock,
        uint256 total
    );
    event VerdictReached(
        address indexed hook,
        uint32 indexed nonce,
        Breaker.Verdict verdict,
        uint16 shareBps,
        address leader,
        uint256 figure,
        uint256 total,
        bool applied
    );
    event PostMortemCommissioned(address indexed hook, uint32 indexed nonce, bytes32 requestId);
    event PostMortemDelivered(address indexed hook, uint32 indexed nonce, string uri);

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
    function launch(bytes calldata body) external nonReentrant onlySteward returns (bytes32 requestId) {
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

    /// @notice Binds the launched pool, once: the factory must name this desk as the launch's
    /// requester and the pool's hook must answer to it.
    /// @dev Steward-only because both conditions can be met by a stranger: anyone can launch a pool
    /// whose hook names this desk as owner and then hand the desk the requester share with
    /// `LaunchFactory.setRequester`. Bound first, such a decoy would take the launch slot and spend
    /// the treasury on whatever "incidents" its hook reports.
    function bind(uint64 n) external nonReentrant onlySteward {
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
    function bindDrill(address hook) external nonReentrant onlySteward {
        if (ICurbHook(hook).owner() != address(this)) revert NotOurHook(hook);
        if (pools[hook].kind != Kind.None) revert AlreadyBound();
        _register(hook, Kind.Drill, 0);
    }

    /// @notice Tops up the treasury. Anyone may.
    function fund(uint256 amount) external nonReentrant {
        imd.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    // ---- incidents ----

    /// @notice Asks the oracle about the halt in progress on `hook`, once per incident. Anyone may
    /// call it; the desk pays, from LP fees it sweeps first on a launch pool.
    function fileIncident(address hook) external nonReentrant returns (bytes32 requestId) {
        Pool memory pool = pools[hook];
        if (pool.kind == Kind.None) revert UnknownPool(hook);
        ICurbHook.Status memory s = ICurbHook(hook).status();
        if (s.phase != Breaker.Phase.Halted) revert NotHalted();
        Incident storage inc = incidents[hook][s.nonce];
        if (inc.state != IncidentState.None) revert AlreadyFiled(s.nonce);
        // Marked before any external call: one question per incident, whatever calls back.
        inc.state = IncidentState.Filed;
        if (pool.kind == Kind.Launch) {
            // Fees pay for the question when there are any; a claim that fails costs only its gas.
            try factory.claimFees(pool.launchNumber) {} catch {}
        }
        uint64 headNow = head();
        if (headNow < s.toBlock + MIN_DEPTH) revert WindowTooFresh(s.toBlock, headNow);

        uint256 price = _pay(ORACLE_REQUEST);
        (bytes memory body, bytes32 questionHash) = oracleBody(hook, s.fromBlock, s.toBlock);
        requestId = intake.requestWithFailure(
            ORACLE_REQUEST,
            body,
            IIntake.Callback(address(this), this.onOracleResult.selector),
            this.onRequestFailure.selector,
            address(imd),
            price
        );
        pending[requestId] = Pending(hook, s.nonce, questionHash);
        inc.fromBlock = s.fromBlock;
        inc.toBlock = s.toBlock;
        inc.requestId = requestId;
        inc.total = s.windowVolume;
        emit IncidentFiled(hook, s.nonce, requestId, questionHash, s.fromBlock, s.toBlock, s.windowVolume);
    }

    /// @notice The oracle's answer, delivered by the Intake under its 200,000 gas stipend.
    function onOracleResult(bytes32 requestId, OracleAttestation.Attestation calldata a, bytes calldata signature)
        external
        nonReentrant
        onlyIntake
    {
        _settle(requestId, a, signature);
    }

    /// @notice The same answer, pushed by anyone from `GET /oracle/requests/:id/attestation` when
    /// the callback did not land. The signature and the pinned question make the caller irrelevant.
    function submitAttestation(bytes32 requestId, OracleAttestation.Attestation calldata a, bytes calldata signature)
        external
        nonReentrant
    {
        _settle(requestId, a, signature);
    }

    /// @notice The rule: the top trader's share of the window's paired-currency volume.
    function classify(uint256 figure, uint256 total) public pure returns (Breaker.Verdict, uint16 shareBps) {
        // A leader with no volume is not an answer this question can have; read it as no answer.
        if (total == 0 || figure == 0 || figure > total) return (Breaker.Verdict.Inconclusive, 0);
        shareBps = uint16(Math.mulDiv(figure, 10_000, total));
        if (shareBps <= ORGANIC_MAX_BPS) return (Breaker.Verdict.Organic, shareBps);
        if (shareBps >= CONCENTRATED_MIN_BPS) return (Breaker.Verdict.Concentrated, shareBps);
        return (Breaker.Verdict.Inconclusive, shareBps);
    }

    // ---- post-mortems ----

    /// @notice Hires the swarm to write up an answered incident, only while the treasury could
    /// still pay for the next incident's question afterwards.
    function commissionPostMortem(address hook, uint32 nonce) external nonReentrant returns (bytes32 requestId) {
        Incident storage inc = incidents[hook][nonce];
        if (inc.state != IncidentState.Answered) revert NotAnswered(nonce);
        if (inc.jobRequestId != bytes32(0)) revert AlreadyCommissioned(nonce);
        uint256 jobPrice = _priceOf(JOB_OPEN);
        uint256 need = jobPrice + _priceOf(ORACLE_REQUEST);
        uint256 have = imd.balanceOf(address(this));
        if (have < need) revert TreasuryShort(have, need);
        imd.forceApprove(address(intake), jobPrice);
        requestId = intake.request(
            JOB_OPEN,
            postMortemBody(hook, nonce),
            IIntake.Callback(address(this), this.onResult.selector),
            address(imd),
            jobPrice
        );
        inc.jobRequestId = requestId;
        postMortems[requestId] = IncidentRef(hook, nonce);
        emit PostMortemCommissioned(hook, nonce, requestId);
    }

    // ---- the Intake's callbacks ----

    /// @notice A job's result: the launch, or a post-mortem.
    function onResult(bytes32 requestId, bytes32 resultHash, string calldata uri) external nonReentrant onlyIntake {
        IncidentRef memory ref = postMortems[requestId];
        if (requestId == launchRequestId && requestId != bytes32(0)) {
            launchState = RequestState.Completed;
            launchResultHash = resultHash;
            launchUri = uri;
        } else if (ref.hook != address(0)) {
            incidents[ref.hook][ref.nonce].reportUri = uri;
            emit PostMortemDelivered(ref.hook, ref.nonce, uri);
        } else {
            revert UnknownRequest(requestId);
        }
        emit ResultDelivered(requestId, resultHash, uri);
    }

    /// @notice A refused or failed request. Unsigned, so it only records what the Intake said: the
    /// incident is closed as failed and is not asked again, since a second ask would pay again.
    function onRequestFailure(bytes32 requestId, uint8 status, bytes32 reason, uint16, uint16, bytes calldata)
        external
        nonReentrant
        onlyIntake
    {
        Pending memory p = pending[requestId];
        if (p.questionHash != bytes32(0)) {
            delete pending[requestId];
            incidents[p.hook][p.nonce].state = IncidentState.Failed;
        } else if (requestId == launchRequestId && requestId != bytes32(0)) {
            launchState = RequestState.Failed;
        } else {
            revert UnknownRequest(requestId);
        }
        emit RequestFailed(requestId, status, reason);
    }

    // ---- the steward ----

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

    // ---- views ----

    function incident(address hook, uint32 nonce) external view returns (Incident memory) {
        return incidents[hook][nonce];
    }

    function hookCount() external view returns (uint256) {
        return hooks.length;
    }

    /// @notice The question the desk asks about `hook` over a block window, built from the hook's
    /// address and the window alone.
    function question(address hook, uint64 fromBlock, uint64 toBlock)
        public
        view
        returns (OracleQuestion.Question memory q)
    {
        q.question = string.concat(
            "On Robinhood Chain, between L2 blocks ",
            Strings.toString(fromBlock),
            " and ",
            Strings.toString(toBlock),
            ", rank the trader keys of the Trade(address indexed trader, uint256 volume) events emitted by contract ",
            Strings.toHexString(hook),
            " by their summed volume. Which trader address has the largest summed volume? Answer a list holding that one address."
        );
        q.chainId = block.chainid;
        q.fromBlock = fromBlock;
        q.toBlock = toBlock;
        q.answerType = OracleAttestation.ANSWER_ADDRESS_LIST;
        q.head = 1;
    }

    /// @notice The `oracle.request` body for that question and the hash its answer must carry.
    function oracleBody(address hook, uint64 fromBlock, uint64 toBlock)
        public
        view
        returns (bytes memory body, bytes32 questionHash)
    {
        OracleQuestion.Question memory q = question(hook, fromBlock, toBlock);
        body = OracleQuestion.body(q, PANEL_SIZE, QUORUM, VALID_FOR);
        questionHash = OracleQuestion.hash(q);
    }

    /// @notice The `job.open` body for an answered incident's post-mortem.
    function postMortemBody(address hook, uint32 nonce) public view returns (bytes memory) {
        Incident storage inc = incidents[hook][nonce];
        string memory objective = string.concat(
            "Write a post-mortem of Curb circuit-breaker incident ",
            Strings.toString(nonce),
            " on the Uniswap v4 hook ",
            Strings.toHexString(hook),
            " on Robinhood Chain (chain 4663). The pool halted after its price held at the edge of its band; the incident window is L2 blocks ",
            Strings.toString(inc.fromBlock),
            " to ",
            Strings.toString(inc.toBlock),
            ". The IMD oracle attested trader ",
            Strings.toHexString(inc.leader)
        );
        objective = string.concat(
            objective,
            " with ",
            Strings.toString(inc.figure),
            " of ",
            Strings.toString(inc.total),
            " paired-currency volume (",
            Strings.toString(inc.shareBps),
            " basis points) and Curb applied the verdict ",
            _verdictName(inc.verdict),
            ". Using the hook's Trade, ReferenceRolled, LimitEntered, Resolved and HaltClosed events and the PoolManager's Swap events for the pool, explain what moved the price, whether the verdict fits the evidence, and what the pool's holders should know."
        );
        return bytes.concat('{"objective":', OracleQuestion.jsonString(objective), ',"template":"research"}');
    }

    /// @notice This chain's own block number.
    function head() public view returns (uint64) {
        return L2Block.number(true);
    }

    // ---- internals ----

    function _settle(bytes32 requestId, OracleAttestation.Attestation calldata a, bytes calldata signature) internal {
        Pending memory p = pending[requestId];
        if (p.questionHash == bytes32(0)) revert UnknownRequest(requestId);
        // The binding: the hash is signed with the answer, so this is the answer to this
        // incident's question or it is refused, whoever delivered it.
        if (a.questionHash != p.questionHash) revert WrongQuestion(p.questionHash, a.questionHash);
        if (a.panelSize < PANEL_SIZE || a.quorum < QUORUM || a.agreed < a.quorum) {
            revert PanelTooWeak(a.panelSize, a.agreed);
        }
        delete pending[requestId];
        _verifyAttestation(a, signature);
        _consume(a.requestId);

        Incident storage inc = incidents[p.hook][p.nonce];
        address[] memory leaders = decodeAddressList(a);
        Breaker.Verdict v = Breaker.Verdict.Inconclusive;
        uint16 bps = 0;
        address leader = address(0);
        if (leaders.length == 1) {
            leader = leaders[0];
            (v, bps) = classify(a.figure, inc.total);
        }
        inc.state = IncidentState.Answered;
        inc.verdict = v;
        inc.shareBps = bps;
        inc.leader = leader;
        inc.figure = a.figure;
        bool applied = false;
        if (v == Breaker.Verdict.Organic || v == Breaker.Verdict.Concentrated) {
            // A late answer finds the halt over or another incident running, and the hook says no.
            // It is still recorded: the verdict is a fact about that incident either way.
            try ICurbHook(p.hook).resolve(p.nonce, v) {
                applied = true;
                inc.applied = true;
            } catch {}
        }
        emit VerdictReached(p.hook, p.nonce, v, bps, leader, a.figure, inc.total, applied);
    }

    /// @dev Approves the Intake for exactly one price of `action`, or reverts naming the shortfall.
    function _pay(bytes32 action) internal returns (uint256 price) {
        price = _priceOf(action);
        uint256 have = imd.balanceOf(address(this));
        if (have < price) revert TreasuryShort(have, price);
        imd.forceApprove(address(intake), price);
    }

    function _priceOf(bytes32 action) internal view returns (uint256 price) {
        price = intake.priceOf(action, address(imd));
        if (price > MAX_PRICE) revert PriceAboveCap(price, MAX_PRICE);
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

    function _verdictName(Breaker.Verdict v) internal pure returns (string memory) {
        if (v == Breaker.Verdict.Organic) return "Organic";
        if (v == Breaker.Verdict.Concentrated) return "Concentrated";
        if (v == Breaker.Verdict.Inconclusive) return "Inconclusive";
        return "None";
    }
}
