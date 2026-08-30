import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Atom,
  BarChart3,
  Beaker,
  BookMarked,
  BookOpen,
  Bookmark,
  Bot,
  Brain,
  BrainCircuit,
  Braces,
  Calculator,
  CalendarDays,
  ChartNoAxesCombined,
  ChartScatter,
  CircuitBoard,
  Cloud,
  Code2,
  Cpu,
  Database,
  Dna,
  Earth,
  FileChartColumnIncreasing,
  FileCode2,
  FilePenLine,
  FileSearch,
  FileSpreadsheet,
  FileStack,
  FileText,
  FlaskConical,
  Folder,
  FolderArchive,
  FolderGit2,
  FolderKanban,
  FolderOpen,
  GitBranch,
  GraduationCap,
  HardDrive,
  Image,
  Languages,
  Library,
  Lightbulb,
  LineChart,
  ListTree,
  Map,
  Microscope,
  Network,
  Newspaper,
  NotepadText,
  NotebookPen,
  PenTool,
  PieChart,
  Presentation,
  Quote,
  Regex,
  Rocket,
  ScrollText,
  Server,
  Shield,
  ShieldCheck,
  Sigma,
  Sparkles,
  StickyNote,
  Target,
  Telescope,
  Terminal,
  TestTubeDiagonal,
  TestTubes,
  University,
  UsersRound,
  Workflow
} from "lucide-react";
import { isProjectIconName, normalizeLucideIconName, projectIconNames, type ProjectIconName } from "../server/projectIcons.js";

const icons: Record<ProjectIconName, LucideIcon> = {
  "file-text": FileText,
  "book-open": BookOpen,
  "notebook-pen": NotebookPen,
  "book-marked": BookMarked,
  "scroll-text": ScrollText,
  library: Library,
  "graduation-cap": GraduationCap,
  presentation: Presentation,
  image: Image,
  "folder-kanban": FolderKanban,
  microscope: Microscope,
  "flask-conical": FlaskConical,
  "test-tube-diagonal": TestTubeDiagonal,
  atom: Atom,
  dna: Dna,
  telescope: Telescope,
  earth: Earth,
  map: Map,
  languages: Languages,
  university: University,
  "code-2": Code2,
  "file-code-2": FileCode2,
  database: Database,
  server: Server,
  network: Network,
  "circuit-board": CircuitBoard,
  brain: Brain,
  "brain-circuit": BrainCircuit,
  bot: Bot,
  "shield-check": ShieldCheck,
  workflow: Workflow,
  sigma: Sigma,
  calculator: Calculator,
  "chart-no-axes-combined": ChartNoAxesCombined,
  "line-chart": LineChart,
  "bar-chart-3": BarChart3,
  "pie-chart": PieChart,
  "chart-scatter": ChartScatter,
  "file-spreadsheet": FileSpreadsheet,
  "file-chart-column-increasing": FileChartColumnIncreasing,
  lightbulb: Lightbulb,
  rocket: Rocket,
  target: Target,
  sparkles: Sparkles,
  "file-pen-line": FilePenLine,
  "file-stack": FileStack,
  folder: Folder,
  "folder-open": FolderOpen,
  "folder-archive": FolderArchive,
  archive: Archive,
  bookmark: Bookmark,
  newspaper: Newspaper,
  "notepad-text": NotepadText,
  "sticky-note": StickyNote,
  "pen-tool": PenTool,
  quote: Quote,
  "list-tree": ListTree,
  "file-search": FileSearch,
  beaker: Beaker,
  "test-tubes": TestTubes,
  "folder-git-2": FolderGit2,
  "git-branch": GitBranch,
  terminal: Terminal,
  braces: Braces,
  regex: Regex,
  cpu: Cpu,
  "hard-drive": HardDrive,
  cloud: Cloud,
  "users-round": UsersRound,
  "calendar-days": CalendarDays
};

export const projectIconEntries = projectIconNames.map((name) => ({ name }));

export function projectInitial(projectName: string): string {
  const initial = Array.from(projectName.trim())[0];
  return initial ? initial.toLocaleUpperCase() : "?";
}

export function ProjectIconGlyph({ icon, fallback, size = 18 }: {
  icon?: string | null;
  fallback: string;
  size?: number;
}) {
  const Icon = isProjectIconName(icon) ? icons[icon] : null;
  if (Icon) return <Icon aria-hidden="true" size={size} strokeWidth={1.9} />;
  const advancedName = normalizeLucideIconName(icon);
  if (advancedName) {
    const iconUrl = `/api/project-icons/${encodeURIComponent(advancedName)}`;
    const mask = `url(${iconUrl})`;
    const style: CSSProperties = { maskImage: mask, WebkitMaskImage: mask };
    return <span aria-hidden="true" className="project-icon-external-glyph" style={style} />;
  }
  return <span aria-hidden="true">{fallback}</span>;
}

export function ProjectIconAvatar({
  icon,
  projectName,
  editable = false,
  onEdit,
  editLabel,
  title,
  className = ""
}: {
  icon?: string | null;
  projectName: string;
  editable?: boolean;
  onEdit?: () => void;
  editLabel?: string;
  title?: string;
  className?: string;
}) {
  const content = <ProjectIconGlyph icon={icon} fallback={projectInitial(projectName)} />;
  const classes = `project-icon-avatar${editable ? " editable" : ""}${className ? ` ${className}` : ""}`;
  if (editable && onEdit) {
    return <button type="button" className={classes} title={editLabel} aria-label={editLabel} onClick={onEdit}>{content}</button>;
  }
  return <span className={classes} title={title} aria-hidden="true">{content}</span>;
}
