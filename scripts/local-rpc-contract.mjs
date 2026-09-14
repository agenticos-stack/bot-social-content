// A 2,000,000-byte poster plus base64 expansion and its bounded metadata.
// Auth and agent messages retain the smaller limit in the BFF.
export const LOCAL_RPC_MAX_BYTES = 3 * 1024 * 1024;

export const SOCIAL_DOOR_METHODS = Object.freeze({
  social: ['createDraft', 'uploadMedia', 'submitForReview', 'readStatus'],
  schedule: ['create', 'list', 'cancel'],
  workspace: ['notify'],
  metered_fetch: ['socialPostsForAccount', 'fetch_media']
});
