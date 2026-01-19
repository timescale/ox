import type { SelectOption } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useState } from 'react';

export interface FilterableSelectorProps {
  title: string;
  description: string;
  options: SelectOption[];
  initialIndex: number;
  showBack?: boolean;
  onSelect: (value: string | null) => void;
  onCancel: () => void;
  onBack?: () => void;
}

export function FilterableSelector({
  title,
  description,
  options,
  initialIndex,
  showBack = false,
  onSelect,
  onCancel,
  onBack,
}: FilterableSelectorProps) {
  const [filterText, setFilterText] = useState('');

  // Find the initial value to track across filter changes
  const initialValue = options[initialIndex]?.value;

  // Compute initial selected index based on the initial value in unfiltered list
  const getInitialIndex = () => {
    const idx = options.findIndex((opt) => opt.value === initialValue);
    return idx >= 0 ? idx : 0;
  };

  const [selectedIndex, setSelectedIndex] = useState(getInitialIndex);

  // Filter options based on text input
  const filteredOptions = options.filter((opt) => {
    const searchText = filterText.toLowerCase();
    return (
      opt.name.toLowerCase().includes(searchText) ||
      (opt.description?.toLowerCase().includes(searchText) ?? false)
    );
  });

  // Clamp selected index to valid range for filtered options
  const clampedIndex = Math.min(
    selectedIndex,
    Math.max(0, filteredOptions.length - 1),
  );

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onCancel();
      return;
    }

    // Back navigation - use Tab when filter is empty
    if (showBack && onBack && key.name === 'tab' && filterText === '') {
      onBack();
      return;
    }

    // Arrow key navigation for the list
    if (key.name === 'up') {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.name === 'down') {
      setSelectedIndex((i) => Math.min(filteredOptions.length - 1, i + 1));
      return;
    }

    // Enter to select current item
    if (key.name === 'return' && filteredOptions.length > 0) {
      const option = filteredOptions[clampedIndex];
      if (option) {
        onSelect(option.value === '__null__' ? null : (option.value as string));
      }
      return;
    }
  });

  const handleFilterInput = (value: string) => {
    setFilterText(value);
    // Reset selection to top when filter changes
    setSelectedIndex(0);
  };

  const handleSelectChange = (index: number, _option: SelectOption | null) => {
    setSelectedIndex(index);
  };

  const helpText = showBack
    ? 'Type to filter, arrows to navigate, Enter to select, Tab (empty filter) to go back, Esc to cancel'
    : 'Type to filter, arrows to navigate, Enter to select, Esc to cancel';

  return (
    <box style={{ flexDirection: 'column', padding: 1, flexGrow: 1 }}>
      <box
        title={title}
        style={{
          border: true,
          borderStyle: 'single',
          padding: 1,
          flexDirection: 'column',
          flexGrow: 1,
        }}
      >
        <text>{description}</text>
        <text style={{ fg: '#888888' }}>{helpText}</text>

        <box style={{ marginTop: 1, flexDirection: 'row', height: 1 }}>
          <text style={{ fg: '#888888' }}>Filter: </text>
          <input
            focused
            value={filterText}
            placeholder="Type to filter..."
            onInput={handleFilterInput}
            style={{
              flexGrow: 1,
              backgroundColor: '#333333',
              textColor: '#ffffff',
            }}
          />
        </box>

        {filteredOptions.length > 0 ? (
          <select
            options={filteredOptions}
            focused={false}
            selectedIndex={clampedIndex}
            onChange={handleSelectChange}
            showScrollIndicator
            style={{
              marginTop: 1,
              flexShrink: 1,
              flexGrow: 1,
              maxHeight: filteredOptions.length * 2,
            }}
          />
        ) : (
          <text style={{ marginTop: 1, fg: '#888888' }}>
            No items match your filter
          </text>
        )}

        <text style={{ marginTop: 1, fg: '#555555' }}>
          {filteredOptions.length} of {options.length} items shown
        </text>
      </box>
    </box>
  );
}
