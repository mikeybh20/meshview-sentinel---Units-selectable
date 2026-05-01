import React from 'react';
import { X, GripVertical, Eye, EyeOff, LayoutTemplate, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { WidgetConfig } from '../types';
import { cn } from '../lib/utils';

interface DashboardDesignerProps {
  widgets: WidgetConfig[];
  onUpdate: (widgets: WidgetConfig[]) => void;
  onClose: () => void;
}

export function DashboardDesigner({ widgets, onUpdate, onClose }: DashboardDesignerProps) {
  const moveWidget = (index: number, direction: 'up' | 'down') => {
    const newWidgets = [...widgets];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex >= 0 && targetIndex < newWidgets.length) {
      [newWidgets[index], newWidgets[targetIndex]] = [newWidgets[targetIndex], newWidgets[index]];
      onUpdate(newWidgets.map((w, i) => ({ ...w, order: i })));
    }
  };

  const toggleVisibility = (id: string) => {
    onUpdate(widgets.map(w => w.id === id ? { ...w, visible: !w.visible } : w));
  };

  const updateWidth = (id: string, width: WidgetConfig['width']) => {
    onUpdate(widgets.map(w => w.id === id ? { ...w, width } : w));
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

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {widgets.map((widget, index) => (
            <div 
              key={widget.id}
              className={cn(
                "p-4 rounded-lg border transition-all flex items-center gap-4 bg-brand-bg/40",
                widget.visible ? "border-brand-line" : "border-brand-line/30 opacity-50"
              )}
            >
              <div className="flex flex-col gap-1">
                <button 
                  disabled={index === 0}
                  onClick={() => moveWidget(index, 'up')}
                  className="p-1 hover:text-brand-accent disabled:opacity-30"
                >
                  <ArrowUp size={14} />
                </button>
                <button 
                  disabled={index === widgets.length - 1}
                  onClick={() => moveWidget(index, 'down')}
                  className="p-1 hover:text-brand-accent disabled:opacity-30"
                >
                  <ArrowDown size={14} />
                </button>
              </div>

              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h4 className="text-xs font-bold uppercase tracking-widest">{widget.type.replace('_', ' ')}</h4>
                  <span className="text-[9px] mono-text opacity-40 bg-brand-line px-1 rounded">{widget.id}</span>
                </div>
                <div className="flex gap-2">
                  {(['full', 'large', 'medium', 'small'] as const).map(w => (
                    <button
                      key={w}
                      onClick={() => updateWidth(widget.id, w)}
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
                onClick={() => toggleVisibility(widget.id)}
                className={cn(
                  "p-2 rounded hover:bg-brand-line transition-all",
                  widget.visible ? "text-brand-accent" : "text-brand-muted"
                )}
              >
                {widget.visible ? <Eye size={18} /> : <EyeOff size={18} />}
              </button>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-brand-line flex justify-end bg-brand-line/10">
          <button 
            onClick={onClose}
            className="bg-brand-accent text-black px-8 py-2 rounded text-sm font-bold uppercase tracking-widest hover:brightness-110 transition-all"
          >
            Finish Customization
          </button>
        </div>
      </div>
    </div>
  );
}
