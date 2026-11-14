import { ENDPOINTS, type EndpointName, type EndpointResponse } from '@abos/contracts';
import { apiError } from './util';

// Every builder route checks its response against the endpoint's response
// schema in the package (ENDPOINTS) before it is sent. A mismatch is a server
// bug, so it answers INTERNAL instead of sending a shape the web app does not
// expect. The value itself is sent unchanged: the check never strips a field.

export function checkedResponse<N extends EndpointName, T extends EndpointResponse<N>>(name: N, value: T): T {
  const result = ENDPOINTS[name].response.safeParse(value);
  if (!result.success) {
    throw apiError('INTERNAL', 'The server built a response that does not match the contract.', {
      endpoint: name,
      paths: result.error.issues.map((i) => i.path.join('.')).slice(0, 10),
    });
  }
  return value;
}
