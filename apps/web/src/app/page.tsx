import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-4xl font-semibold tracking-tight text-[var(--color-navy)]">
        FunLead Recorder
      </h1>
      <p className="text-lg text-slate-600">
        Your self-hosted instance. Record, edit and share — your videos stay on your own storage.
      </p>
      <Link
        href="/dashboard"
        className="rounded-lg bg-[var(--color-navy)] px-5 py-2.5 font-medium text-white transition hover:bg-[#16304d]"
      >
        Go to dashboard
      </Link>
    </main>
  );
}
