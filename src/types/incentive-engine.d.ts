/**
 * @usethink/incentive-engine 类型声明（非官方，手写最小子集）
 *
 * 该包是 CommonJS 纯 JS 库，无内置类型声明。
 * 这里声明 cf-lottery 实际使用的 API 子集：
 * - engine.Distribute.distributeByDefs
 * 其余模块（Allocate/Evaluate/Orchestrate/Services/Validation）暂不使用，不声明。
 */
declare module "@usethink/incentive-engine" {
  /**
   * 引擎事件（简化版，cf-lottery 使用子集）
   */
  export interface EngineEvent {
    sourceNodeId: string;
    eventValue: string;
    eventType?: string;
    attrs?: Record<string, unknown>;
  }

  /**
   * 奖励定义（简化版，cf-lottery 使用 FIXED/CUSTOM/DIRECT 子集）
   */
  export interface RewardDef {
    rewardId: string;
    type: "DIRECT" | "LEVEL" | "FIXED" | "CUSTOM";
    target?: "SOURCE" | "PARENT";
    rate?: string;
    fixedAmount?: string;
    amount?: string;
    amountFrom?: string;
    conditions?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
  }

  /**
   * 引擎计算结果记录
   */
  export interface EngineRecord {
    nodeId: string | null;
    rewardId: string;
    rewardType: string;
    amount: string;
    snapshot: Record<string, unknown>;
  }

  export interface DistributeByDefsParams {
    event: EngineEvent;
    /** 事件来源节点对象（4.0.0 新增必传：target="SOURCE" 时 _resolveGateNode 要求非空） */
    sourceNode?: { id: string; attrs?: Record<string, unknown> } | null;
    directParent?: { id: string; rankRate?: string } | null;
    ancestors?: Array<{ id: string; rankRate?: string }>;
    rewardDefs: RewardDef[];
  }

  export const Distribute: {
    distributeByDefs: (params: DistributeByDefsParams) => EngineRecord[];
  };

  const engine: {
    Distribute: typeof Distribute;
  };
  export default engine;
}