// Static route — for contrast. An RSC request with a malformed
// Next-Router-State-Tree here returns 200/307 (served from the prerendered
// shell; the header is never parsed).
export default function Page() {
  return <div>Static home. See /dyn/[slug] for the dynamic route.</div>;
}
