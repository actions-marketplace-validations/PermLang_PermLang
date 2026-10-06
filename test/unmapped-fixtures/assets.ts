// Asset imports that bundlers handle aren't reported. A query string or fragment
// can't make a script look like one: Node loads ./evil.js for both of the last two.
import "./styles.css";
import "./logo.svg?url";
import "./evil.js?x=.css";
import "./evil.js#.css";

export const loaded = true;
