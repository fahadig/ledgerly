import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';
import { requireUser } from '@/lib/company';

/**
 * Every authenticated page hangs off this layout, so the sign-in check runs
 * once, here, rather than being something each new page has to remember.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireUser();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
