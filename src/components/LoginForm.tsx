export default function LoginForm({
  action,
  error,
}: {
  action: (formData: FormData) => void | Promise<void>;
  error: string | null;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded bg-brand text-base font-black text-white">
            L
          </div>
          <div>
            <div className="text-lg font-bold leading-tight text-ink">Ledgerly</div>
            <div className="text-xs leading-tight text-ink-muted">AI-assisted accounting</div>
          </div>
        </div>

        <form action={action} className="card p-6">
          <h1 className="mb-1 text-xl font-semibold text-ink">Sign in</h1>
          <p className="mb-5 text-sm text-ink-muted">
            Every entry you post is recorded against your name.
          </p>

          {error && (
            <div
              role="alert"
              className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {error}
            </div>
          )}

          <div className="mb-4">
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              className="input"
              placeholder="you@company.com"
            />
          </div>

          <div className="mb-5">
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="input"
              placeholder="••••••••••"
            />
          </div>

          <button type="submit" className="btn-primary w-full">
            Sign in
          </button>
        </form>

        <p className="mt-5 text-center text-xxs leading-relaxed text-ink-light">
          The AI proposes. The ledger validates. A human posts.
        </p>
      </div>
    </div>
  );
}
