import { t } from './i18n.js';
import React from 'react';
import {Notice, Button} from './ui.jsx';
import {errorCopy} from './format.js';

// A stale tab can request a removed lazy chunk after a release. Preserve the shell
// and let the user choose when to reload; never replay writes or auto-reload.
export class ResourceBoundary extends React.Component {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() {
    if (this.state.failed) return <Notice title={t("页面资源暂时无法载入")} action={<Button onClick={() => window.location.reload()}>{t("重新加载页面")}</Button>}>
      {errorCopy({errorCode: 'PAGE_RESOURCES_UNAVAILABLE'})}
    </Notice>;
    return this.props.children;
  }
}
