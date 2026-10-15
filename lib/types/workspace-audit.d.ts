import type { DeliveryAudit } from './quality-gates.ts';
import type { TeamState } from './types.ts';
export declare function auditTeamWorkspace(workspace: string, team: TeamState): DeliveryAudit;
