import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSnapshot } from '../../data/SnapshotContext';
import { canViewFinishSystems } from '../../auth/internalRoles';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { AppSidebar } from '../AppSidebar';
import { ROUTE_PATHS, objectPath } from '../routePaths';
import { RouteError, RouteForbidden, RouteLoading, RouteNotFound } from '../RouteStatus';
import { useFinishSystems, useFinishWorkTypes, useFinishSystemCreate } from '../useFinishSystems';
import { useAreaScopes } from '../useAreaScopes';
import { FinishSystems, type FinishSystemsState } from '../../screens/FinishSystems';
export function FinishSystemsRoute(){
  const {objectId}=useParams<{objectId:string}>(); const snapshot=useSnapshot(); const {session}=useCoreRuntime(); const navigate=useNavigate();
  const object=snapshot.status==='Ready'?snapshot.snapshot.objects.find(x=>x.id===objectId):undefined;
  const allowed=!!session&&canViewFinishSystems(session.user.role); const {load,reload}=useFinishSystems(objectId,allowed&&!!object);
  const workTypes=useFinishWorkTypes(objectId,allowed&&!!object);
  const areaScopes=useAreaScopes(objectId,allowed&&!!object);
  const create=useFinishSystemCreate(objectId,reload);
  const state=useMemo<FinishSystemsState>(()=>load.status==='Ready'?{status:'Ready',items:load.items}:load.status==='Unavailable'?{status:'Unavailable',error:load.error}:load.status==='Error'?{status:'Error',error:load.error}:{status:'Loading'},[load]);
  if(snapshot.status==='Loading')return <RouteLoading/>; if(snapshot.status==='Error')return <RouteError message={snapshot.message}/>; if(!session)return <RouteForbidden label="Системы отделки доступны после входа в Core."/>; if(!allowed)return <RouteForbidden label="Раздел «Системы отделки» доступен руководителю проекта."/>; if(!object)return <RouteNotFound label="Объект не найден"/>;
  return <FinishSystems key={object.id} objectId={object.id} state={state} areaScopes={areaScopes.load} workTypes={workTypes} create={create.state} onCreate={create.submit} onDismissCreateResult={create.reset} sidebar={<AppSidebar/>} objectName={object.name} onRetry={reload} onNavigateHome={()=>navigate(ROUTE_PATHS.company)} onOpenObject={()=>navigate(objectPath(object.id))}/>;
}
