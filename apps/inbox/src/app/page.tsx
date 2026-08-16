import { Button } from "@/components/ui/button";

export default function HomePage(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <div className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">Sema</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Sema staff inbox</h1>
        <p className="text-balance text-muted-foreground">
          The shared inbox, calendar and settings for clinic front-desk staff. Conversations,
          takeover and booking arrive in Phase 8 — see docs/BUILD_PLAN.md.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button disabled>Open inbox</Button>
        <Button variant="outline" disabled>
          Calendar
        </Button>
      </div>
    </main>
  );
}
