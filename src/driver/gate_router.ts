// Compatibility surface for existing callers. New orchestration code owns the decision.
export { decideGate as routeGateVerdict } from '../orchestration/gate_routing';
export type { GateDecision as GateRouteAction } from '../orchestration/gate_routing';
