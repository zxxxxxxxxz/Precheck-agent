export function can(actions: readonly string[] | undefined, action: string) {return actions?.includes(action) ?? false;}
