import { Suspense } from 'react';
import { connection } from 'next/server';

// Dynamically-rendered route. connection() + params access are inside
// <Suspense>, so the route is rendered on demand (not prerendered).
// A request that reaches this handler must parse Next-Router-State-Tree —
// which is where a malformed value triggers HTTP 500 instead of 400.
async function Dynamic({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  return <div>dyn {slug} rendered at {new Date().toISOString()}</div>;
}

export default function Page({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <main>
      <Suspense fallback={<div>loading…</div>}>
        <Dynamic params={params} />
      </Suspense>
    </main>
  );
}
