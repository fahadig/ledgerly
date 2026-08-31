import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAccess } from '@/lib/company';
import { draftEntryFromText } from '@/lib/ai/assistant';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const Body = z.object({
  text: z.string().min(3).max(2000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function POST(req: Request) {
  try {
    if (!(await currentUser())) {
      return NextResponse.json({ ok: false, error: 'Sign in to use the assistant.' }, { status: 401 });
    }
    const body = Body.parse(await req.json());
    const { company, user } = await getAccess();
    const draft = await draftEntryFromText({
      companyId: company.id,
      text: body.text,
      date: body.date,
      userId: user.id,
    });
    return NextResponse.json({ ok: true, draft, currency: company.currency });
  } catch (err) {
    const message = err instanceof z.ZodError ? 'Describe the transaction in a sentence or two.' : (err as Error).message;
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
