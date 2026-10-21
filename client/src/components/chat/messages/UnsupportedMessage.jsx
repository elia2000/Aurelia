/** What a message of a type this client does not know looks like: a quiet note. */
export default function UnsupportedMessage() {
  return (
    <p data-unsupported-message className="text-[14px] italic leading-[1.35] opacity-70">
      This message is not supported by your version of the app.
    </p>
  );
}
