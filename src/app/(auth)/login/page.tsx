import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { attemptLogin, currentUser, pruneSessions } from '@/lib/auth';
import LoginForm from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentUser()) redirect('/');
  const { error } = await searchParams;

  async function signIn(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');

    if (!email || !password) redirect('/login?error=Enter+your+email+and+password.');

    const agent = (await headers()).get('user-agent') ?? undefined;
    const result = await attemptLogin(email, password, agent);

    if (!result.ok) redirect(`/login?error=${encodeURIComponent(result.error ?? 'Sign-in failed.')}`);
    await pruneSessions();
    redirect('/');
  }

  return <LoginForm action={signIn} error={error ?? null} />;
}
