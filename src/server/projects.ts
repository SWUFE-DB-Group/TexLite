import type { DatabaseConnection, UserRow, ProjectRow } from "./db.js";

export type ProjectPermission = "read" | "edit" | "owner";

export interface AccessibleProject extends ProjectRow {
  permission: ProjectPermission;
  owner_username?: string;
  owner_display_name?: string;
  last_modified_username?: string | null;
  last_modified_display_name?: string | null;
}

export function accessibleProject(
  db: DatabaseConnection,
  projectId: string,
  user: UserRow
): AccessibleProject | null {
  if (user.role === "admin") {
    const row = db.prepare(`
      SELECT p.*, 'owner' AS permission, owner.username AS owner_username,
        owner.display_name AS owner_display_name,
        modifier.username AS last_modified_username, modifier.display_name AS last_modified_display_name
      FROM projects p
      JOIN users owner ON owner.id = p.owner_id
      LEFT JOIN users modifier ON modifier.id = p.last_modified_by
      WHERE p.id = ?
    `).get(projectId) as AccessibleProject | undefined;
    return row ?? null;
  }
  const row = db.prepare(`
    SELECT p.*,
      CASE WHEN p.owner_id = ? THEN 'owner' ELSE pm.permission END AS permission,
      owner.username AS owner_username, owner.display_name AS owner_display_name,
      modifier.username AS last_modified_username, modifier.display_name AS last_modified_display_name
    FROM projects p
    JOIN users owner ON owner.id = p.owner_id
    LEFT JOIN users modifier ON modifier.id = p.last_modified_by
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
    WHERE p.id = ? AND (p.owner_id = ? OR pm.user_id IS NOT NULL)
  `).get(user.id, user.id, projectId, user.id) as AccessibleProject | undefined;
  return row ?? null;
}

export function canEdit(project: AccessibleProject): boolean {
  return project.permission === "owner" || project.permission === "edit";
}
