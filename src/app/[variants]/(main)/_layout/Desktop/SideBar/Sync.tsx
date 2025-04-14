import { ActionIcon, Form, Input } from '@lobehub/ui';
import { Button, Popover } from 'antd';
import { CloudCogIcon } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flexbox } from 'react-layout-kit';

import { remoteServerService } from '@/services/electron/remoteServer';

/**
 * 同步按钮组件
 * 用于配置远程服务器连接
 */
const Sync = memo(() => {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [serverStatus, setServerStatus] = useState<{
    error?: boolean;
    isActive?: boolean;
    message?: string;
  }>({});

  // 获取远程服务器配置
  const fetchRemoteServerConfig = useCallback(async () => {
    try {
      const config = await remoteServerService.getRemoteServerConfig();
      setServerUrl(config.remoteServerUrl || '');
      setServerStatus({
        error: false,
        isActive: config.isRemoteServerActive,
        message: config.isRemoteServerActive
          ? t('remoteServer.statusConnected', '已连接')
          : t('remoteServer.statusDisconnected', '未连接'),
      });
      return config;
    } catch (error) {
      console.error('获取远程服务器配置失败:', error);
      setServerStatus({
        error: true,
        isActive: false,
        message: t('remoteServer.fetchError', '获取配置失败'),
      });
      return { isRemoteServerActive: false, remoteServerUrl: '' };
    }
  }, [t]);

  // 打开弹窗时获取配置
  const handleOpenChange = useCallback(
    async (visible: boolean) => {
      setOpen(visible);
      if (visible) {
        await fetchRemoteServerConfig();
      }
    },
    [fetchRemoteServerConfig],
  );

  // 处理表单提交
  const handleSubmit = useCallback(
    async (values: { serverUrl: string }) => {
      if (!values.serverUrl) return;

      setLoading(true);
      try {
        // 获取当前配置
        const config = await remoteServerService.getRemoteServerConfig();

        // 如果已经激活，需要先清除
        if (config.isRemoteServerActive) {
          await remoteServerService.clearRemoteServerConfig();
        }

        // 请求授权
        const result = await remoteServerService.requestAuthorization(values.serverUrl);

        if (!result.success) {
          console.error('请求授权失败:', result.error);
          setServerStatus({
            error: true,
            isActive: false,
            message: t('remoteServer.authError', '授权失败: {{error}}', { error: result.error }),
          });
        } else {
          setServerStatus({
            error: false,
            isActive: false,
            message: t('remoteServer.authPending', '请在浏览器中完成授权'),
          });
          // 关闭弹窗
          setOpen(false);
        }
      } catch (error) {
        console.error('远程服务器配置出错:', error);
        setServerStatus({
          error: true,
          isActive: false,
          message: t('remoteServer.configError', '配置出错'),
        });
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  // 断开连接
  const handleDisconnect = useCallback(async () => {
    setLoading(true);
    try {
      await remoteServerService.clearRemoteServerConfig();
      setServerStatus({
        error: false,
        isActive: false,
        message: t('remoteServer.disconnected', '已断开连接'),
      });
      // 更新表单URL为空
      setServerUrl('');
    } catch (error) {
      console.error('断开连接失败:', error);
      setServerStatus({
        error: true,
        message: t('remoteServer.disconnectError', '断开连接失败'),
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

  return (
    <Popover
      content={
        <Flexbox gap={16} padding={16} style={{ width: 300 }}>
          <Flexbox gap={8}>
            <h3 style={{ margin: 0 }}>{t('remoteServer.configTitle', '配置云同步')}</h3>
            <p style={{ margin: 0, opacity: 0.6 }}>
              {t('remoteServer.configDesc', '连接到远程LobeChat服务器，启用数据同步')}
            </p>
          </Flexbox>

          <Form initialValues={{ serverUrl }} onFinish={handleSubmit}>
            <Form.Item
              extra={
                serverStatus.message && (
                  <div style={{ color: serverStatus.error ? 'red' : 'inherit' }}>
                    {serverStatus.message}
                  </div>
                )
              }
              label={t('remoteServer.serverUrl', '服务器地址')}
              name="serverUrl"
              rules={[
                { message: t('remoteServer.urlRequired', '请输入服务器地址'), required: true },
                {
                  message: t('remoteServer.invalidUrl', '请输入有效的URL地址'),
                  type: 'url',
                },
              ]}
            >
              <Input
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://example.com"
                value={serverUrl}
              />
            </Form.Item>

            <Flexbox distribution="space-between" gap={8} horizontal>
              {serverStatus.isActive ? (
                <Button danger loading={loading} onClick={handleDisconnect}>
                  {t('remoteServer.disconnect', '断开连接')}
                </Button>
              ) : (
                <Button htmlType="submit" loading={loading} type="primary">
                  {t('remoteServer.connect', '连接并授权')}
                </Button>
              )}
              <Button onClick={() => setOpen(false)}>{t('common.cancel', '取消')}</Button>
            </Flexbox>
          </Form>
        </Flexbox>
      }
      onOpenChange={handleOpenChange}
      open={open}
      placement="right"
      trigger="click"
    >
      <ActionIcon
        icon={CloudCogIcon}
        placement={'right'}
        size="large"
        title={t('remoteServer.configTitle', '配置云同步')}
      />
    </Popover>
  );
});

export default Sync;
