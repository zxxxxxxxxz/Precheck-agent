// Match browser/Vite asset loading failures, not arbitrary application TypeErrors.
export function isPageLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (?:CSS )?chunk .+ failed/i.test(error.message);
}
