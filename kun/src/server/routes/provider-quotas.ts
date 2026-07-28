import { jsonResponse, type JsonResponse } from '../response.js'
import type { ProviderQuotaService } from '../../services/provider-quota-service.js'

export async function listProviderQuotas(
  service: Pick<ProviderQuotaService, 'list'>
): Promise<JsonResponse> {
  return jsonResponse(await service.list())
}
