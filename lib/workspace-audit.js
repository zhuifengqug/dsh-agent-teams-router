/** The single workspace audit consumed by every delivery surface. */
import { MAX_EXPANDED_ARTIFACTS, readArtifactScope } from "./artifacts.js";
import { deliveryArtifactPaths, deliveryScopePatterns } from "./quality-gates.js";
export function auditTeamWorkspace(workspace, team) {
    const paths = deliveryArtifactPaths(team);
    const scopes = deliveryScopePatterns(team);
    const pathReads = [];
    for (let offset = 0; offset < paths.length; offset += MAX_EXPANDED_ARTIFACTS)
        pathReads.push(readArtifactScope(workspace, paths.slice(offset, offset + MAX_EXPANDED_ARTIFACTS)));
    const direct = { artifacts: pathReads.flatMap(read => read.artifacts), gaps: pathReads.flatMap(read => read.gaps) };
    const scopeReads = scopes.map(scope => readArtifactScope(workspace, [scope]));
    const scoped = { artifacts: scopeReads.flatMap(read => read.artifacts), gaps: scopeReads.flatMap(read => read.gaps) };
    const gaps = [...direct.gaps, ...scoped.gaps];
    const seen = new Set(gaps.map(gap => `${gap.pattern}\u0000${gap.reason}`));
    for (const artifact of [...direct.artifacts, ...scoped.artifacts]) {
        if (artifact.unreadable !== true)
            continue;
        const reason = artifact.reason ?? 'path could not be read';
        const key = `${artifact.path}\u0000${reason}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        gaps.push({ pattern: artifact.path, reason });
    }
    const artifacts = [...direct.artifacts, ...scoped.artifacts]
        .filter((artifact, index, all) => all.findIndex(item => item.path === artifact.path && item.sha256 === artifact.sha256 && item.present === artifact.present) === index);
    return {
        artifacts,
        expandedScope: scoped.artifacts.map(artifact => ({ path: artifact.path, present: artifact.present })),
        ...(gaps.length === 0 ? {} : { gaps }),
    };
}
