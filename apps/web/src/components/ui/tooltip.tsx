import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cn } from '@/lib/utils';

/**
 * shadcn's Base UI tooltip (base-nova), written in by hand. One change from upstream: the popup is
 * square — a tooltip is a container, and only what you can press is rounded. (Upstream's
 * `TooltipProvider` is left out until a screen wants a shared delay.)
 */
function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = 'top',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'z-50 w-fit max-w-xs origin-(--transform-origin) rounded-none bg-foreground px-3 py-1.5 text-background text-xs text-balance data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0',
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipTrigger };
