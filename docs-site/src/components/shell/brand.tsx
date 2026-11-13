/** Same mark and wordmark as the Valtrums web app. */
export function Brand() {
  return (
    <span className="brand">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/valtrum-logo.png" width={34} height={34} alt="" />
      <span className="brand-word">VALTRUMS</span>
      <span className="brand-docs">Docs</span>
    </span>
  );
}
