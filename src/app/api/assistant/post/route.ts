import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCan } from '@/lib/company';
import { currentUser } from '@/lib/auth';
import { postJournal } from '@/lib/ledger';
import { checkEntry } from '@/lib/ai/rules';
import { recordOutcome } from '@/lib/ai/assistant';

export const dynamic = 'force-dynamic';

const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(500).optional(),
  aiAssisted: z.boolean().optional(),
  logId: z.string().optional(),
  correctedByHuman: z.boolean().optional(),
  standardRefs: z.array(z.string()).optional(),
  lines: z
    .array(
      z.object({
        accountId: z.string().min(1),
        debitCents: z.number().int().min(0),
        creditCents: z.number().int().min(0),
        description: z.string().max(300).optional(),
        contactId: z.string().nullish(),
        dimensionValueIds: z.array(z.string()).nullish(),
      }),
    )
    .min(2),
});

export async function POST(req: Request) {
  try {
    if (!(await currentUser())) {
      return NextResponse.json({ ok: false, error: 'Sign in to post entries.' }, { status: 401 });
    }

    // Role check before anything is read or written.
    const { company, user } = await assertCan('post');
    const body = Body.parse(await req.json());

    // Never trust the client: re-run every check server-side before posting.
    const check = await checkEntry({
      companyId: company.id,
      date: body.date,
      memo: body.memo,
      lines: body.lines,
    });

    if (!check.postable) {
      return NextResponse.json(
        { ok: false, error: 'This entry cannot be posted.', findings: check.findings },
        { status: 422 },
      );
    }

    const entry = await postJournal({
      companyId: company.id,
      date: new Date(`${body.date}T00:00:00Z`),
      memo: body.memo ?? null,
      source: 'MANUAL',
      aiAssisted: body.aiAssisted ?? false,
      standardRefs: body.standardRefs ?? null,
      createdBy: `${user.name} <${user.email}>`,
      lines: body.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debitCents,
        credit: l.creditCents,
        description: l.description ?? null,
        contactId: l.contactId ?? null,
        dimensionValueIds: l.dimensionValueIds ?? null,
      })),
    });

    if (body.logId) {
      await recordOutcome(body.logId, {
        accepted: true,
        correctedByHuman: body.correctedByHuman,
        journalEntryId: entry.id,
      }).catch(() => undefined);
    }

    return NextResponse.json({
      ok: true,
      entryNo: entry.entryNo,
      id: entry.id,
      warnings: check.findings.filter((f) => f.severity !== 'BLOCK'),
    });
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message ?? 'Invalid entry.' : (err as Error).message;
    const status = /does not allow you to/.test(message) ? 403 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
