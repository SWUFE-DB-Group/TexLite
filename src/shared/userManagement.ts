/** System-wide user-management counts, independent of search and pagination. */
export interface UserManagementSummary {
  totalUsers: number;
  administrators: number;
  projectCreators: number;
  totalProjects: number;
  projectOwners: number;
}
