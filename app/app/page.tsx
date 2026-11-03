import { redirect } from 'next/navigation';

/**
 * 插件内的根路径：不提供独立落地页。
 * 侧栏点「紫微斗数」进的是 /ziwei/chart；这里只是把误入的访问者送回排盘页。
 */
export default function RootPage() {
  redirect('/chart');
}
