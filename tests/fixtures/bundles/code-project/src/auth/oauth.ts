export function authenticate(token: string): boolean {
  return token.length > 0;
}
