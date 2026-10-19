// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {CurbDesk} from "../desk/CurbDesk.sol";
import {CurbHook} from "../src/CurbHook.sol";
import {IIntake} from "../src/interfaces/IIntake.sol";
import {ILaunchFactory} from "../src/interfaces/ILaunchFactory.sol";
import {CurbRouter} from "../src/tools/CurbRouter.sol";
import {DrillToken} from "../src/tools/DrillToken.sol";

/// @notice Robinhood Chain deployments, one step per entry point:
///
/// Run with `FOUNDRY_PROFILE=deploy`, the profile that may write `deployments/`:
///
///   forge script script/Mainnet.s.sol --sig "core()"        --rpc-url $RH_RPC --broadcast
///   forge script script/Mainnet.s.sol --sig "buyImd(uint256)" <maxWei> --rpc-url $RH_RPC --broadcast
///   forge script script/Mainnet.s.sol --sig "drill()"       --rpc-url $RH_RPC --broadcast
///
/// The key comes from `DEPLOYER_KEY`. Addresses are written to `deployments/4663.json`.
contract Mainnet is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant INTAKE = 0xa43e6F75ee006411F79Ac1C84120606C2330DE82;
    address constant IMD = 0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127;
    address constant FACTORY = 0xA25B02A1e93903b790E6aaf7dA1b8B8d50294645;
    address constant ORACLE_SIGNER = 0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = 0x20C0;
    string constant OUT = "deployments/4663.json";

    /// @dev The drill pool: DRILL/ETH at about 1e10 DRILL per ETH, single-sided DRILL just under the
    /// opening price, so a few cents of ETH move the price through its whole band.
    int24 constant DRILL_OPEN_TICK = 230_400;
    int24 constant DRILL_LOWER = 227_400;
    int24 constant DRILL_UPPER = 230_340;
    uint128 constant DRILL_LIQUIDITY = 1e19;

    function core() external {
        uint256 key = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(key);
        vm.startBroadcast(key);
        CurbRouter router = new CurbRouter(IPoolManager(POOL_MANAGER));
        CurbDesk desk = new CurbDesk(IIntake(INTAKE), IERC20(IMD), ILaunchFactory(FACTORY), ORACLE_SIGNER, deployer);
        vm.stopBroadcast();
        string memory o = "core";
        vm.serializeAddress(o, "router", address(router));
        vm.serializeAddress(o, "steward", deployer);
        string memory json = vm.serializeAddress(o, "desk", address(desk));
        vm.writeJson(json, OUT);
        console.log("router", address(router));
        console.log("desk", address(desk));
    }

    /// @notice Buys exactly 0.52 IMD with ETH on the IMD/ETH pool, spending at most `maxWei`.
    function buyImd(uint256 maxWei) external {
        uint256 key = vm.envUint("DEPLOYER_KEY");
        CurbRouter router = CurbRouter(_addr(".router"));
        PoolKey memory imdEth = PoolKey(Currency.wrap(address(0)), Currency.wrap(IMD), 10_000, 100, IHooks(address(0)));
        vm.startBroadcast(key);
        router.swap{value: maxWei}(imdEth, true, 0.52 ether, TickMath.MIN_SQRT_PRICE + 1);
        vm.stopBroadcast();
        console.log("IMD", IERC20(IMD).balanceOf(vm.addr(key)));
    }

    function drill() external {
        uint256 key = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(key);
        CurbRouter router = CurbRouter(_addr(".router"));
        CurbDesk desk = CurbDesk(_addr(".desk"));

        vm.startBroadcast(key);
        DrillToken token = new DrillToken();
        vm.stopBroadcast();

        bytes memory code = abi.encodePacked(
            type(CurbHook).creationCode,
            abi.encode(
                POOL_MANAGER,
                address(token),
                deployer,
                address(desk),
                int24(300),
                int24(60),
                uint32(120),
                uint32(10),
                uint32(300),
                uint32(300),
                uint32(1),
                true
            )
        );
        bytes32 salt = _mine(code);
        address predicted = _predict(salt, code);

        PoolKey memory k =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 12500, 60, IHooks(predicted));
        vm.startBroadcast(key);
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, code));
        require(ok && predicted.code.length > 0, "hook deployment failed");
        IPoolManager(POOL_MANAGER).initialize(k, TickMath.getSqrtPriceAtTick(DRILL_OPEN_TICK));
        token.approve(address(router), type(uint256).max);
        router.addLiquidity(k, DRILL_LOWER, DRILL_UPPER, DRILL_LIQUIDITY);
        desk.bindDrill(predicted);
        vm.stopBroadcast();

        string memory o = "drill";
        vm.serializeAddress(o, "drillToken", address(token));
        string memory json = vm.serializeAddress(o, "drillHook", predicted);
        vm.writeJson(json, OUT, ".drill");
        console.log("drill token", address(token));
        console.log("drill hook", predicted);
    }

    function _mine(bytes memory code) internal pure returns (bytes32) {
        bytes32 codeHash = keccak256(code);
        for (uint256 i = 0; i < 1_000_000; i++) {
            address at = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, bytes32(i), codeHash))))
            );
            if (uint160(at) & 0x3FFF == FLAGS) return bytes32(i);
        }
        revert("no salt");
    }

    function _predict(bytes32 salt, bytes memory code) internal pure returns (address) {
        return
            address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(code)))))
            );
    }

    function _addr(string memory path) internal view returns (address) {
        return vm.parseJsonAddress(vm.readFile(OUT), path);
    }
}
