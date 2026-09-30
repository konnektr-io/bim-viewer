/**
 * A panel card whose body folds away behind a clickable header.
 *
 * WHY ONE COMPONENT FOR ALL FOUR PANELS
 * ------------------------------------
 * The layers card, the section card and the two inspectors are four different
 * bodies with one shared behaviour: they are all chrome sitting on top of a
 * viewport, and the reason to collapse one is always the same — you want the
 * model, not the controls. Four hand-rolled collapsers is four chances to
 * disagree about what collapsed means; this is where they agree instead.
 *
 * The state is remembered in localStorage, so a panel you folded away stays
 * folded on the next load. That is the behaviour worth having: the panels you
 * collapse are the ones you never want to see again, and re-expanding them
 * every reload is the cost that makes people stop collapsing anything.
 *
 * Collapsed renders NO body at all (rather than a hidden one), so a folded
 * panel costs nothing to keep in the DOM and cannot be scraped by a test that
 * reads the panel's text.
 */
import { useCallback, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const STORAGE_PREFIX = "bim-viewer:panel:";

/**
 * Read a remembered state, falling back to the caller's default.
 *
 * localStorage can throw outright (a blocked-cookies context, a full quota), so
 * a missing memory is never allowed to break the panel.
 */
function readRemembered(id: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + id);
    return raw === null ? fallback : raw !== "collapsed";
  } catch {
    return fallback;
  }
}

function remember(id: string, open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + id, open ? "open" : "collapsed");
  } catch {
    // Not being able to remember is not a reason to fail the toggle.
  }
}

export function CollapsiblePanel({
  id,
  title,
  titleClassName,
  actions,
  defaultOpen = true,
  testId,
  className,
  children,
}: {
  /** Stable identity: the storage key, and the `aria-controls` link. */
  id: string;
  title: ReactNode;
  /** Header typography. Section labels are uppercase, the model title is not. */
  titleClassName?: string;
  /** Stays visible while collapsed — the controls you still want to reach. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readRemembered(id, defaultOpen));

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    remember(id, next);
  }, [id, open]);

  return (
    // A collapsed panel is a title bar, so it drops the card's roomy vertical
    // padding. Open, it keeps the padding every panel has always had.
    <Card className={cn(open ? undefined : "gap-0 py-2", className)} data-testid={testId}>
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={toggle}
            data-panel-toggle={id}
            aria-expanded={open}
            aria-controls={`${id}-body`}
            aria-label={`${open ? "Collapse" : "Expand"} ${typeof title === "string" ? title : id}`}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                open ? "rotate-180" : "-rotate-90",
              )}
            />
            <span
              className={cn(
                "truncate text-xs font-medium uppercase tracking-wider text-muted-foreground",
                titleClassName,
              )}
            >
              {title}
            </span>
          </button>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>
      </CardHeader>

      {open ? (
        <CardContent id={`${id}-body`} className="min-w-0">
          {children}
        </CardContent>
      ) : null}
    </Card>
  );
}
