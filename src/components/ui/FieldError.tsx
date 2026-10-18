/**
 * Inline form field error message. Renders nothing when message is empty.
 * Props: message.
 */
export function FieldError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-sm text-red-500">
      {message}
    </p>
  );
}
