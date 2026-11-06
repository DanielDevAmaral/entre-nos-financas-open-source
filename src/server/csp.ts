export function contentSecurityPolicy(nonce: string, development = false) {
  if (!/^[A-Za-z0-9+/=]{16,128}$/.test(nonce))
    throw new Error("Nonce inválido.");
  return (
    "default-src 'self'; script-src 'self' 'nonce-" +
    nonce +
    "' 'strict-dynamic'" +
    (development ? " 'unsafe-eval'" : "") +
    "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"
  );
}
