import React from 'react';
import { SeamlessNote, type SeamlessNoteProps } from './SeamlessNote';

export interface InlineCommentEditorProps {
  initialValue: string;
  onSave: (val: string) => void;
  onCancel?: () => void;
  label?: string;
  placeholder?: string;
}

export const InlineCommentEditor: React.FC<InlineCommentEditorProps> = ({
  initialValue,
  onSave,
  onCancel,
  placeholder = 'Write a note...',
}) => {
  return (
    <SeamlessNote
      text={initialValue}
      onSave={onSave}
      onCancel={onCancel}
      placeholder={placeholder}
      isTargeted={true}
    />
  );
};

export { SeamlessNote, type SeamlessNoteProps };
