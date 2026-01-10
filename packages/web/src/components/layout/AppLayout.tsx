/**
 * AppLayout component.
 *
 * Responsive layout with sidebar for desktop and slide navigation for mobile.
 */

import { useState, useEffect, type ReactNode } from 'react';
import { clsx } from 'clsx';

interface AppLayoutProps {
  readonly sidebar: ReactNode;
  readonly main: ReactNode;
  readonly showSidebar?: boolean;
}

/** Hook to detect mobile viewport */
function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false,
  );

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < breakpoint);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [breakpoint]);

  return isMobile;
}

export function AppLayout({
  sidebar,
  main,
  showSidebar = true,
}: AppLayoutProps) {
  const isMobile = useIsMobile();

  // Mobile: slide navigation
  if (isMobile) {
    return (
      <div className="relative h-full w-full overflow-hidden">
        {/* Sidebar - slides in from left */}
        <div
          className={clsx(
            'absolute inset-y-0 left-0 w-full transform transition-transform duration-300 ease-out',
            showSidebar ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {sidebar}
        </div>

        {/* Main - slides in from right */}
        <div
          className={clsx(
            'absolute inset-y-0 left-0 w-full transform transition-transform duration-300 ease-out',
            showSidebar ? 'translate-x-full' : 'translate-x-0',
          )}
        >
          {main}
        </div>
      </div>
    );
  }

  // Desktop: side-by-side
  return (
    <div className="flex h-full w-full">
      {/* Sidebar */}
      <aside
        className={clsx(
          'h-full border-r border-[--color-border]',
          'w-80 shrink-0',
          'transition-all duration-300',
        )}
      >
        {sidebar}
      </aside>

      {/* Main content */}
      <main className="flex-1">{main}</main>
    </div>
  );
}
