'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

interface Props {
  companies: { id: string; name: string; framework: string; functionalCurrency: string }[];
  activeId: string;
  groupName: string | null;
}

export default function CompanySwitcher({ companies, activeId, groupName }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const switchTo = (id: string) => {
    document.cookie = `ledgerly.company=${id}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh());
  };

  const active = companies.find((c) => c.id === activeId);

  return (
    <div className="flex items-center gap-3">
      <div className="text-right leading-tight">
        {groupName && <div className="text-xxs uppercase tracking-wide text-ink-light">{groupName}</div>}
        <div className="text-xxs text-ink-muted">
          {active ? `${active.framework === 'US_GAAP' ? 'US GAAP' : 'IFRS'} · ${active.functionalCurrency}` : ''}
        </div>
      </div>
      <select
        value={activeId}
        disabled={pending}
        onChange={(e) => switchTo(e.target.value)}
        className="rounded border border-line bg-white px-3 py-1.5 text-sm font-semibold outline-none focus:border-brand"
        aria-label="Active company"
      >
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
