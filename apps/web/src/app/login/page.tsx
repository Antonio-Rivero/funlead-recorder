import { redirect } from "next/navigation";
import { isOwner } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isOwner()) redirect("/dashboard");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-navy)]">
          Sign in
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Enter the owner password for this instance.
        </p>
      </div>
      <LoginForm />
    </main>
  );
}
