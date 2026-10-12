import { createContext, useContext } from 'react';

/** Which server + project the tabs (Chat / Files / Changes / Terminal) belong to. */
export interface ProjectRef {
  hostId: string;
  projectPath: string;
}

export const ProjectContext = createContext<ProjectRef | null>(null);

/** Read by the project tabs. Provided by host/[hostId]/project/[projectKey]/_layout.tsx. */
export function useProject(): ProjectRef {
  const p = useContext(ProjectContext);
  if (!p) throw new Error('useProject must be used inside a project');
  return p;
}
