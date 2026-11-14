import {configure} from '@testing-library/dom';

// Component tests wait for the mock API to answer. The default wait of one
// second is too short on a busy machine (several workers and dev servers
// running at once), which made tests fail for no real reason. Five seconds
// keeps a real failure fast enough and removes the false ones.
configure({asyncUtilTimeout: 5000});
