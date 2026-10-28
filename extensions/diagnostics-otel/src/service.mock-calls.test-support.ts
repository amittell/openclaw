export function mockCall(mock: { mock: { calls: unknown[][] } }, callIndex = 0): unknown[] {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call;
}

export function mockCallArg(
  mock: { mock: { calls: unknown[][] } },
  argIndex: number,
  callIndex = 0,
) {
  return mockCall(mock, callIndex)[argIndex];
}
