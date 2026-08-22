import assert from 'node:assert/strict';
import test from 'node:test';

import { getSyntheticRichAction } from '../lib/synthetic-rich-action.mjs';

class FakeMedia {
  constructor(mimetype, data, filename, filesize) {
    this.mimetype = mimetype;
    this.data = data;
    this.filename = filename;
    this.filesize = filesize;
  }
}

class FakeLocation {
  constructor(lat, lng, extra) {
    this.lat = lat;
    this.lng = lng;
    this.extra = extra;
  }
}

test('synthetic rich actions stay locally generated and attested', () => {
  const image = getSyntheticRichAction('image', { MessageMedia: FakeMedia, Location: FakeLocation });
  const png = Buffer.from(image.content().data, 'base64');
  assert.equal(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
  assert.equal(image.sha256.length, 64);
  assert.equal(image.options.caption, '[E2E TEST 2/6 — IMAGE]');

  const contact = getSyntheticRichAction('contact', { MessageMedia: FakeMedia, Location: FakeLocation });
  assert.match(contact.content(), /E2E Synthetic Contact/);
  assert.match(contact.content(), /\+12025550123/);

  assert.throws(
    () => getSyntheticRichAction('image'),
    /MessageMedia and Location/,
  );
  assert.throws(
    () => getSyntheticRichAction('nope', { MessageMedia: FakeMedia, Location: FakeLocation }),
    /Unsupported rich test kind/,
  );
});
