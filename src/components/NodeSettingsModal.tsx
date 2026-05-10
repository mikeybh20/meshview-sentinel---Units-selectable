import React, { useState } from 'react';
import { X, Save, RotateCcw, Activity } from 'lucide-react';
import { Node, NodeSettings } from '../types';
import { simulator } from '../services/meshtasticSimulator';

interface NodeSettingsModalProps {
  node: Node;
  onClose: () => void;
}

export function NodeSettingsModal({ node, onClose }: NodeSettingsModalProps) {
  const [settings, setSettings] = useState<NodeSettings>(node.settings || {
    longName: node.name,
    shortName: node.shortName,
    hopLimit: 3,
    broadcastInterval: 300,
    channelName: 'Default',
    modemPreset: 'LONG_FAST'
  });

  const [isSaving, setIsSaving] = useState(false);

  const handleSave = () => {
    setIsSaving(true);
    // Simulate API delay
    setTimeout(() => {
      simulator.updateNode(node.id, { 
        name: settings.longName,
        shortName: settings.shortName,
        settings 
      });
      setIsSaving(false);
      onClose();
    }, 800);
  };

  return (
    <div className="fixed inset-0 bg-brand-bg/80 backdrop-blur-md z-[200] flex items-center justify-center p-6">
      <div className="technical-panel w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-brand-line flex items-center justify-between bg-brand-line/10">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold tracking-tight uppercase">Remote Config</h3>
            <span className="text-[10px] mono-text opacity-50 bg-brand-line px-1.5 rounded">{node.id}</span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-brand-line rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Identity Section */}
          <section className="space-y-4">
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-brand-accent border-b border-brand-accent/20 pb-1">Node Identity</h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold text-brand-muted">Long Name</label>
                <input 
                  type="text" 
                  value={settings.longName}
                  onChange={e => setSettings({...settings, longName: e.target.value})}
                  className="w-full bg-brand-line/50 border border-brand-line rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-accent transition-colors"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold text-brand-muted">Short Name</label>
                <input 
                  type="text" 
                  maxLength={4}
                  value={settings.shortName}
                  onChange={e => setSettings({...settings, shortName: e.target.value.toUpperCase()})}
                  className="w-full bg-brand-line/50 border border-brand-line rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-accent transition-colors uppercase"
                />
              </div>
            </div>
          </section>

          {/* Radio Section */}
          <section className="space-y-4">
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-brand-accent border-b border-brand-accent/20 pb-1">Radio Configuration</h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold text-brand-muted">Hop Limit</label>
                <select 
                   value={settings.hopLimit}
                   onChange={e => setSettings({...settings, hopLimit: parseInt(e.target.value)})}
                   className="w-full bg-brand-line/50 border border-brand-line rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-accent transition-colors"
                >
                  {[1,2,3,4,5,6,7].map(h => <option key={h} value={h}>{h} Hops</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold text-brand-muted">Broadcast Interval</label>
                <select 
                   value={settings.broadcastInterval}
                   onChange={e => setSettings({...settings, broadcastInterval: parseInt(e.target.value)})}
                   className="w-full bg-brand-line/50 border border-brand-line rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-accent transition-colors"
                >
                  <option value={60}>1 Minute</option>
                  <option value={300}>5 Minutes</option>
                  <option value={600}>10 Minutes</option>
                  <option value={1800}>30 Minutes</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase font-bold text-brand-muted">Modem Preset</label>
              <div className="grid grid-cols-2 gap-2">
                {['LONG_FAST', 'LONG_SLOW', 'MEDIUM_FAST', 'SHORT_FAST'].map(preset => (
                  <button 
                    key={preset}
                    onClick={() => setSettings({...settings, modemPreset: preset as any})}
                    className={`px-3 py-2 text-[10px] font-bold rounded border transition-all ${
                      settings.modemPreset === preset 
                        ? 'bg-brand-accent border-brand-accent text-black' 
                        : 'border-brand-line hover:border-brand-muted bg-brand-line/20'
                    }`}
                  >
                    {preset.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Channel Section */}
          <section className="space-y-4">
             <h4 className="text-[10px] font-bold uppercase tracking-widest text-brand-accent border-b border-brand-accent/20 pb-1">Primary Channel</h4>
             <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold text-brand-muted">Channel Name</label>
                <input 
                  type="text" 
                  value={settings.channelName}
                  onChange={e => setSettings({...settings, channelName: e.target.value})}
                  className="w-full bg-brand-line/50 border border-brand-line rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-accent transition-colors"
                />
              </div>
          </section>
        </div>

        <div className="p-4 border-t border-brand-line flex justify-between items-center bg-brand-line/10">
          <button 
            onClick={() => setSettings(node.settings || settings)}
            className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest hover:text-brand-accent transition-colors"
          >
            <RotateCcw size={14} />
            Reset
          </button>
          <div className="flex gap-3">
            <button 
              onClick={onClose}
              className="px-4 py-2 text-sm font-bold uppercase tracking-widest hover:text-brand-ink transition-colors"
            >
              Cancel
            </button>
            <button 
              onClick={handleSave}
              disabled={isSaving}
              className={`flex items-center gap-2 bg-brand-accent text-black px-6 py-2 rounded text-sm font-bold uppercase tracking-widest hover:brightness-110 transition-all ${isSaving ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {isSaving ? <Activity size={16} className="animate-spin" /> : <Save size={16} />}
              {isSaving ? 'Applying...' : 'Apply Config'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
