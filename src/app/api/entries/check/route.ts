import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCompany } from '@/lib/company';
import { currentUser } from '@/lib/auth';
import { checkEntry } from '@/lib/ai/rules';

export const dynamic = 'force-dynamic';

const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().optional(),
  lines: z.array(
    z.object({
      accountId: z.string(),
      debitCents: z.number().int(),
      creditCents: z.number().int(),
      description: z.string().optional(),
      contactId: z.string().nullish(),
    }),
  ),
});

export async function POST(req: Request) {
  try {
    if (!(await currentUser())) {
      return NextResponse.json({ ok: false, error: 'Sign in first.' }, { status: 401 });
    }
    const body = Body.parse(await req.json());
    const company = await getCompany();
    const result = await checkEntry({ companyId: company.id, ...body });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
