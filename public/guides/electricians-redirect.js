// Historical English card links now use the browser language on the unified page.
const params = new URLSearchParams(location.search);
location.replace('/guides/electricians.html?' + params.toString() + location.hash);
