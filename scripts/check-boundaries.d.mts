export interface BoundaryViolation {
  file: string;
  line: number;
  column: number;
  code: string;
  specifier: string;
}
export function checkWorkspaceBoundaries(rootDirectory: string): {
  filesChecked: number;
  importsChecked: number;
  violations: BoundaryViolation[];
};
