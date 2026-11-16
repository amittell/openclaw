export function mockCall<T extends unknown[]>(mock: { mock: { calls: T[] } }, callIndex = 0): T {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call;
}

export function mockCallArg<T extends unknown[], K extends number>(
  mock: { mock: { calls: T[] } },
  argIndex: K,
  callIndex = 0,
) {
  return mockCall(mock, callIndex)[argIndex];
}
