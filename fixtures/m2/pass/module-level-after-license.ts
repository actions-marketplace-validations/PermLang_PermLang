// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Example Corp

/**
 * A license header above the module comment doesn't hide it.
 * @module
 * @perm net(api.stripe.com)
 */

export async function getCharges() {
  return fetch("https://api.stripe.com/v1/charges");
}
