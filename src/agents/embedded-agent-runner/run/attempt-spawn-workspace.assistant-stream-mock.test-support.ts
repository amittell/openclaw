// Completed assistant stream that the default embedded session double returns
// from its stream function: one "done" reply and no streamed events.
export function createCompletedAssistantStream() {
  return {
    async result() {
      return { role: "assistant", content: "done" };
    },
    [Symbol.asyncIterator]() {
      return (async function* () {})();
    },
  };
}
