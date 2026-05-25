import React from 'react';
import { Reorder, useDragControls } from 'motion/react';
import { X, GripVertical, Eye, EyeOff, LayoutTemplate, RotateCcw } from 'lucide-react';
import { WidgetConfig } from '../types';
import { cn } from '../lib/utils';

interface DashboardDesignerProps {
  widgets: WidgetConfig[];
  onUpdate: (widgets: WidgetConfig[]) => void;
  onClose: () => void;
}

/**
 * Drag-to-reorder dashboard layout editor. The motion/react Reorder primitive
 * handles the actual drag mechanics (touch + mouse, with FLIP animation between
 * positions); we just feed it the widgets array and persist on every change.
 *
 * The grip handle is the drag target rather than the whole row so toggling
 * visibility / clicking width buttons doesn't accidentally start a drag.
 *
 * Layout (visibility / order / width) persists to localStorage from App.tsx —
 * changes here survive reloads AND container rebuilds.
 */
export function DashboardDesigner({ widgets, onUpdate, onClose }: DashboardDesignerProps) {
  const handleReorder = (next: WidgetConfig[]) => {
    // Rewrite `order` to match the new array index so callers that sort by it
    // see the latest layout.
    onUpdate(next.map((w, i) => ({ ...w, order: i })));
  };

  const toggleVisibility = (id: string) => {
    onUpdate(widgets.map(w => w.id === id ? { ...w, visible: !w.visible } : w));
  };

  const updateWidth = (id: string, width: WidgetConfig['width']) => {
    onUpdate(widgets.map(w => w.id === id ? { ...w, width } : w));
  };

  const resetToDefaults = () => {
    if (!confirm('Reset dashboard layout to factory defaults? Your widget visibility, order, and widths will be replaced.')) return;
    // Drop the persisted layout and reload so App.tsx repopulates from defaults.
    try { localStorage.removeItem('mesh.dashboardWidgets.v1'); } catch { /* */ }
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 bg-brand-bg/80 backdrop-blur-md z-[200] flex items-center justify-center p-6">
      <div className="technical-panel w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-brand-line flex items-center justify-between bg-brand-line/10">
          <div className="flex items-center gap-2">
            <LayoutTemplate size={18} className="text-brand-accent" />
            <h3 className="text-lg font-bold tracking-tight uppercase">Dashboard Layout Designer</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-brand-line rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-3 border-b border-brand-line bg-brand-line/10">
          <p className="text-[11px] text-brand-muted leading-snug">
            Drag the <GripVertical size={11} className="inline mb-0.5" /> handle to reorder widgets.
            Toggle the eye to show / hide. Pick a width per widget. Changes persist across reloads and rebuilds.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <Reorder.Group axis="y" values={widgets} onReorder={handleReorder} className="space-y-2">
            {widgets.map(widget => (
              <DesignerRow
                key={widget.id}
                widget={widget}
                onToggleVisibility={() => toggleVisibility(widget.id)}
                onUpdateWidth={w => updateWidth(widget.id, w)}
              />
            ))}
          </Reorder.Group>
        </div>

        <div className="p-4 border-t border-brand-line flex items-center justify-between bg-brand-line/10">
          <button
            onClick={resetToDefaults}
            className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-brand-muted hover:text-brand-error border border-brand-line hover:border-brand-error/50 rounded transition-colors"
            title="Reset to factory layout"
          >
            <RotateCcw size={11} />
            Reset
          </button>
          <button
            onClick={onClose}
            className="bg-brand-accent text-black px-8 py-2 rounded text-sm font-bold uppercase tracking-widest hover:brightness-110 transition-all"
          >
            Finish
          </button>
        </div>
      </div>
    </div>
  );
}

function DesignerRow({
  widget,
  onToggleVisibility,
  onUpdateWidth,
}: {
  widget: WidgetConfig;
  onToggleVisibility: () => void;
  onUpdateWidth: (w: WidgetConfig['width']) => void;
}) {
  // Scoping drag controls per row so only the grip handle starts a drag —
  // tapping width / visibility buttons mustn't accidentally pick up the row.
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      value={widget}
      dragListener={false}
      dragControls={dragControls}
      className={cn(
        "p-3 rounded-lg border transition-all flex items-center gap-3 bg-brand-bg/40 select-none",
        widget.visible ? "border-brand-line" : "border-brand-line/30 opacity-50"
      )}
    >
      {/* Drag handle — only this element initiates a drag */}
      <button
        type="button"
        onPointerDown={e => dragControls.start(e)}
        className="cursor-grab active:cursor-grabbing text-brand-muted hover:text-brand-accent shrink-0 px-1"
        title="Drag to reorder"
        aria-label="Drag handle"
      >
        <GripVertical size={16} />
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h4 className="text-xs font-bold uppercase tracking-widest truncate">
            {widget.type.replace(/_/g, ' ')}
          </h4>
          <span className="text-[9px] mono-text opacity-40 bg-brand-line px-1 rounded shrink-0">
            {widget.id}
          </span>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {(['full', 'large', 'medium', 'small'] as const).map(w => (
            <button
              key={w}
              onClick={() => onUpdateWidth(w)}
              className={cn(
                "text-[9px] px-2 py-0.5 rounded border transition-all uppercase font-bold",
                widget.width === w
                  ? "bg-brand-accent border-brand-accent text-black"
                  : "border-brand-line hover:border-brand-muted"
              )}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={onToggleVisibility}
        className={cn(
          "p-2 rounded hover:bg-brand-line transition-all shrink-0",
          widget.visible ? "text-brand-accent" : "text-brand-muted"
        )}
        title={widget.visible ? 'Hide widget' : 'Show widget'}
      >
        {widget.visible ? <Eye size={16} /> : <EyeOff size={16} />}
      </button>
    </Reorder.Item>
  );
}
