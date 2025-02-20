import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { isEmpty } from 'lodash';
import { Alert, Button, Tooltip } from 'antd';
import { TopLevelSpec, compile } from 'vega-lite';
import embed, { EmbedOptions, Result } from 'vega-embed';
import ChartSpecHandler from './handler';
import ReloadOutlined from '@ant-design/icons/ReloadOutlined';
import EditOutlined from '@ant-design/icons/EditOutlined';
import EyeOutlined from '@ant-design/icons/EyeOutlined';
import PushPinOutlined from '@ant-design/icons/PushpinOutlined';

const embedOptions: EmbedOptions = {
  mode: 'vega-lite',
  renderer: 'svg',
  tooltip: { theme: 'custom' },
  actions: {
    export: true,
    editor: false,
  },
};

interface VegaLiteProps {
  className?: string;
  width?: number | string;
  height?: number | string;
  spec?: TopLevelSpec;
  values?: Record<string, any>[];
  autoFilter?: boolean;
  hideActions?: boolean;
  hideTitle?: boolean;
  hideLegend?: boolean;
  forceUpdate?: number;
  onReload?: () => void;
  onEdit?: () => void;
  onPin?: () => void;
}

export default function Chart(props: VegaLiteProps) {
  const {
    className,
    spec,
    values,
    width = 600,
    height = 320,
    autoFilter,
    hideActions,
    hideTitle,
    hideLegend,
    forceUpdate,
    onReload,
    onEdit,
    onPin,
  } = props;

  const [donutInner, setDonutInner] = useState(null);
  const [isShowTopCategories, setIsShowTopCategories] = useState(false);
  const $view = useRef<Result>(null);
  const $container = useRef<HTMLDivElement>(null);
  const vegaSpec = useMemo(() => {
    if (!spec || !values) return;
    const specHandler = new ChartSpecHandler(
      {
        ...spec,
        data: { values },
      },
      {
        donutInner,
        isShowTopCategories: autoFilter || isShowTopCategories,
        isHideLegend: hideLegend,
        isHideTitle: hideTitle,
      },
    );
    const chartSpec = specHandler.getChartSpec();
    const isDataEmpty = isEmpty((chartSpec?.data as any)?.values);
    if (isDataEmpty) return null;
    return compile(chartSpec, {
      config: specHandler.config,
    }).spec;
  }, [spec, values, isShowTopCategories, donutInner, forceUpdate]);

  // initial vega view
  useEffect(() => {
    if ($container.current && vegaSpec) {
      embed($container.current, vegaSpec, embedOptions).then((view) => {
        $view.current = view;
      });
    }
    return () => {
      if ($view.current) $view.current.finalize();
    };
  }, [vegaSpec, forceUpdate]);

  useEffect(() => {
    if ($container.current) {
      setDonutInner($container.current.clientHeight * 0.15);
    }
  }, [forceUpdate]);

  const onShowTopCategories = () => {
    setIsShowTopCategories(!isShowTopCategories);
  };

  if (vegaSpec === null) {
    if (values.length === 0) return <div>Нет данных</div>;
    return (
      <Alert
        className="mt-6 mb-4 mx-4"
        message={
          <div className="d-flex align-center justify-space-between">
            <div>
              Слишком много категорий для эффективного отображения. Нажмите
              "Показать топ 25", чтобы увидеть лучшие результаты, или задайте
              уточняющий вопрос, чтобы сосредоточиться на конкретной группе или
              отфильтровать результаты.
            </div>
            <Button
              size="small"
              icon={<EyeOutlined />}
              onClick={onShowTopCategories}
            >
              Show top 25
            </Button>
          </div>
        }
        type="warning"
      />
    );
  }

  const isAdditionalShow = !!onReload || !!onEdit || !!onPin;

  return (
    <div
      className={clsx(
        'adm-chart',
        { 'adm-chart--no-actions': hideActions },
        className,
      )}
      style={{ width }}
    >
      {isAdditionalShow && (
        <div className="adm-chart-additional d-flex justify-content-between align-center">
          {!!onReload && (
            <Tooltip title="Перегенерировать график">
              <button onClick={onReload}>
                <ReloadOutlined />
              </button>
            </Tooltip>
          )}
          {!!onEdit && (
            <Tooltip title="Редактировать график">
              <button onClick={onEdit}>
                <EditOutlined />
              </button>
            </Tooltip>
          )}
          {!!onPin && (
            <Tooltip title="Закрепить график на панели управления">
              <button onClick={onPin}>
                <PushPinOutlined />
              </button>
            </Tooltip>
          )}
        </div>
      )}
      <div style={{ width, height }} ref={$container} />
    </div>
  );
}
