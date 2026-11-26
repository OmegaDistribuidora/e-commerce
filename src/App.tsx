import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  BadgePercent,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  Heart,
  ImageOff,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MapPin,
  Menu,
  Minus,
  PackageCheck,
  Plus,
  Search,
  ShoppingCart,
  SlidersHorizontal,
  Store,
  Trash2,
  X,
} from "lucide-react";
import AccountPage from "./AccountPage";
import OrdersPage from "./OrdersPage";
import StaffPortal from "./StaffPortal";
import ProductPage from "./ProductPage";
import CampaignsPage from "./CampaignsPage";
import AboutPage from "./AboutPage";
import PartnersPage from "./PartnersPage";
import { HeroSkeleton, Skeleton } from "./Skeleton";
import { authenticatedFetch } from "./api";
import {
  campaignQuantitiesForCart,
  money,
  productPriceForQuantity,
  unitMoney,
} from "./data";
import { formatCatalogName } from "./catalog";
import { supabase } from "./supabase";
import type {
  Banner,
  CartItem,
  CatalogDepartment,
  CommercialConditions,
  Customer,
  DiscountCampaign,
  OrderQuote,
  Partner,
  Product,
  StaffUser,
} from "./types";
import { formatDocument } from "./validation";

const whatsappUrl = `https://wa.me/558592020207?text=${encodeURIComponent("Olá! Venho do e-Commerce da Ômega Distribuidora e preciso de atendimento!")}`;

function queryCodes(value: string | null) {
  return [
    ...new Set(
      (value || "")
        .split(",")
        .map(Number)
        .filter((code) => Number.isSafeInteger(code) && code > 0),
    ),
  ];
}

function normalizeSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

function App() {
  if (window.location.pathname === "/conta") return <AccountPage />;
  if (window.location.pathname === "/pedidos") return <OrdersPage />;
  if (window.location.pathname === "/gestao") return <StaffPortal />;
  if (window.location.pathname === "/campanhas") return <CampaignsPage />;
  if (window.location.pathname === "/sobre") return <AboutPage />;
  if (window.location.pathname === "/parceiros") return <PartnersPage />;
  const productMatch = /^\/produto\/(\d+)$/.exec(window.location.pathname);
  if (productMatch) return <ProductPage code={Number(productMatch[1])} />;
  const parameters = new URLSearchParams(window.location.search);
  const supplierId = Number(parameters.get("fornecedor"));
  const supplierIds = queryCodes(parameters.get("fornecedores"));
  if (Number.isFinite(supplierId) && supplierId > 0)
    supplierIds.push(supplierId);
  return (
    <StorePage
      initialSupplierIds={[...new Set(supplierIds)]}
      initialSectionCodes={queryCodes(parameters.get("secoes"))}
      initialProductCodes={queryCodes(parameters.get("produtos"))}
      initialDepartment={parameters.get("departamento") || ""}
      initialSection={parameters.get("secao") || ""}
      initialQuery={parameters.get("busca") || ""}
      initialCartOpen={parameters.get("carrinho") === "1"}
      initialMode={
        parameters.get("modo") === "mais-vendidos" ? "bestsellers" : "featured"
      }
      initialCampaignCode={Number(parameters.get("campanha")) || 0}
      initialBannerId={Number(parameters.get("banner")) || 0}
    />
  );
}

function StorePage({
  initialSupplierIds,
  initialSectionCodes,
  initialProductCodes,
  initialDepartment,
  initialSection,
  initialQuery,
  initialCartOpen,
  initialMode,
  initialCampaignCode,
  initialBannerId,
}: {
  initialSupplierIds: number[];
  initialSectionCodes: number[];
  initialProductCodes: number[];
  initialDepartment: string;
  initialSection: string;
  initialQuery: string;
  initialCartOpen: boolean;
  initialMode: "featured" | "bestsellers";
  initialCampaignCode: number;
  initialBannerId: number;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [productsError, setProductsError] = useState("");
  const [query, setQuery] = useState(initialQuery);
  const [supplierFilter, setSupplierFilter] = useState(
    initialSupplierIds.length === 1 ? String(initialSupplierIds[0]) : "",
  );
  const [destinationSupplierIds, setDestinationSupplierIds] =
    useState(initialSupplierIds);
  const [destinationSectionCodes, setDestinationSectionCodes] =
    useState(initialSectionCodes);
  const [destinationProductCodes, setDestinationProductCodes] =
    useState(initialProductCodes);
  const [campaignCode, setCampaignCode] = useState(initialCampaignCode);
  const [activeCampaign, setActiveCampaign] = useState<DiscountCampaign | null>(null);
  const [loadedCampaignCode, setLoadedCampaignCode] = useState(initialCampaignCode);
  const [activeBannerId, setActiveBannerId] = useState(initialBannerId);
  const bannerOnlyRoute = initialBannerId > 0 && !initialSupplierIds.length &&
    !initialSectionCodes.length && !initialProductCodes.length && !initialCampaignCode;
  const [bannerRouteReady, setBannerRouteReady] = useState(!bannerOnlyRoute);
  const [bannerRouteMissing, setBannerRouteMissing] = useState(false);
  const isBannerDestination =
    activeBannerId > 0 ||
    destinationSupplierIds.length > 0 ||
    destinationSectionCodes.length > 0 ||
    destinationProductCodes.length > 0 ||
    campaignCode > 0;
  const [departmentFilter, setDepartmentFilter] = useState(initialDepartment);
  const [sectionFilter, setSectionFilter] = useState(initialSection);
  const [departments, setDepartments] = useState<CatalogDepartment[]>([]);
  const [partnerLogos, setPartnerLogos] = useState<Partner[]>([]);
  const [expandedDepartment, setExpandedDepartment] =
    useState(initialDepartment);
  const [catalogMode, setCatalogMode] = useState<"featured" | "bestsellers">(
    initialMode,
  );
  const [visibleCount, setVisibleCount] = useState(25);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [cartOpen, setCartOpen] = useState(initialCartOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [partnersMenuClosed, setPartnersMenuClosed] = useState(false);
  const [closedDepartmentMenu, setClosedDepartmentMenu] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [sendingOrder, setSendingOrder] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [commercialConditions, setCommercialConditions] =
    useState<CommercialConditions | null>(null);
  const [quote, setQuote] = useState<OrderQuote | null>(null);
  const [couponDraft, setCouponDraft] = useState("");
  const [appliedCouponCode, setAppliedCouponCode] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [loadingConditions, setLoadingConditions] = useState(false);
  const [orderNumber, setOrderNumber] = useState("");
  const [slides, setSlides] = useState<Banner[]>([]);
  const [loadingBanners, setLoadingBanners] = useState(true);
  const [loadingNavigation, setLoadingNavigation] = useState(true);
  const [catalogBanners, setCatalogBanners] = useState<Banner[]>([]);
  const [bannerPageTitle, setBannerPageTitle] = useState("");
  const [slide, setSlide] = useState(0);
  const [slidePausedUntil, setSlidePausedUntil] = useState(0);
  const [toast, setToast] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<Set<number>>(new Set());
  const [stockCheckingIds, setStockCheckingIds] = useState<Set<number>>(
    new Set(),
  );
  const stockChecksRef = useRef(new Set<number>());
  const productsRef = useRef<HTMLElement>(null);
  const heroTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressHeroClickRef = useRef(false);

  useEffect(() => {
    authenticatedFetch("/api/auth/me")
      .then(async (response) => (response.ok ? response.json() : null))
      .then(async (data) => {
        const authenticatedCustomer =
          data?.accountType === "customer" ? data.customer : null;
        const authenticatedStaff =
          data?.accountType === "staff" ? data.user : null;
        setCustomer(authenticatedCustomer);
        setStaffUser(authenticatedStaff);
        if (authenticatedCustomer?.canOrder) {
          const cartResponse = await authenticatedFetch("/api/customer/cart");
          const cartData = await cartResponse.json().catch(() => ({ items: [] }));
          setCart(cartResponse.ok && Array.isArray(cartData.items) ? cartData.items : []);
        } else {
          setCart([]);
        }
      })
      .catch(() => {
        setCustomer(null);
        setStaffUser(null);
      })
      .finally(() => setAuthReady(true));
  }, []);

  // Logo após o primeiro acesso as condições comerciais ainda estão chegando do WinThor
  // (cerca de 1 minuto). Consulta a conta até liberar e recarrega a loja com os preços.
  useEffect(() => {
    if (!customer?.pricesPending) return;
    const timer = window.setInterval(() => {
      authenticatedFetch("/api/auth/me")
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (data?.accountType === "customer" && !data.customer?.pricesPending)
            window.location.reload();
        })
        .catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [customer?.pricesPending]);

  useEffect(() => {
    if (!authReady) return;
    const controller = new AbortController();
    setLoadingProducts(true);
    authenticatedFetch(
      `/api/products?limit=5000&sort=${catalogMode}${campaignCode > 0 ? `&campaign=${campaignCode}` : ""}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        setProducts(data.products);
        setLoadedCampaignCode(campaignCode);
        setProductsError("");
        setVisibleCount(25);
      })
      .catch((error) => {
        if (error.name !== "AbortError")
          setProductsError("Não foi possível carregar o catálogo agora.");
      })
      .finally(() => setLoadingProducts(false));
    return () => controller.abort();
  }, [authReady, catalogMode, customer?.id, campaignCode]);

  useEffect(() => {
    if (!authReady) return;
    const controller = new AbortController();
    authenticatedFetch('/api/products?featured=1&limit=5', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Destaques indisponíveis');
        return response.json();
      })
      .then((data) => setFeaturedProducts(Array.isArray(data.products) ? data.products : []))
      .catch(() => setFeaturedProducts([]));
    return () => controller.abort();
  }, [authReady, customer?.id]);

  useEffect(() => {
    if (!authReady || campaignCode <= 0) {
      setActiveCampaign(null);
      return;
    }
    const controller = new AbortController();
    authenticatedFetch("/api/campaigns", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Não foi possível carregar a campanha.");
        return response.json();
      })
      .then((data) => {
        setActiveCampaign(
          (data.campaigns || []).find((campaign: DiscountCampaign) => campaign.code === campaignCode) || null,
        );
      })
      .catch((error) => {
        if (error.name !== "AbortError") setActiveCampaign(null);
      });
    return () => controller.abort();
  }, [authReady, campaignCode, customer?.id]);

  useEffect(() => {
    if (authReady && !customer) setCart([]);
  }, [authReady, customer]);
  useEffect(() => {
    if (!authReady || !customer) {
      setFavoriteIds(new Set());
      return;
    }
    authenticatedFetch("/api/customer/favorites")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        setFavoriteIds(
          new Set(
            (data.favorites || []).map((product: Product) =>
              Number(product.id),
            ),
          ),
        );
      })
      .catch(() => setFavoriteIds(new Set()));
  }, [authReady, customer?.id]);
  useEffect(() => {
    if (!authReady) return;
    let selectedBannerFound = false;
    let pendingRequests = 2;
    const finishBannerRequest = () => {
      pendingRequests -= 1;
      if (bannerOnlyRoute && pendingRequests === 0 && !selectedBannerFound) {
        setBannerRouteMissing(true);
        setBannerRouteReady(true);
      }
    };
    const applySelectedBanner = (banners: Banner[]) => {
      const selected = banners.find((banner) => banner.id === initialBannerId);
      if (!selected) return;
      selectedBannerFound = true;
      setBannerPageTitle(selected.altText);
      if (bannerOnlyRoute) {
        setDestinationSupplierIds(selected.destinationType === 'suppliers' ? selected.destinationValues : []);
        setDestinationSectionCodes(selected.destinationType === 'sections' ? selected.destinationValues : []);
        setDestinationProductCodes(selected.destinationType === 'products' ? selected.destinationValues : []);
        setCampaignCode(selected.destinationType === 'campaigns' ? selected.destinationValues[0] || 0 : 0);
        setSupplierFilter(selected.destinationType === 'suppliers' && selected.destinationValues.length === 1 ? String(selected.destinationValues[0]) : '');
        setBannerRouteMissing(false);
        setBannerRouteReady(true);
      }
    };
    setLoadingBanners(true);
    authenticatedFetch("/api/banners")
      .then((response) => response.json())
      .then((data) => {
        if (Array.isArray(data.banners)) {
          setSlides(data.banners);
          applySelectedBanner(data.banners);
        }
      })
      .catch(() => setSlides([]))
      .finally(() => { setLoadingBanners(false); finishBannerRequest(); });
    authenticatedFetch("/api/banners?placement=catalog")
      .then((response) => response.json())
      .then((data) => {
        if (Array.isArray(data.banners)) {
          setCatalogBanners(data.banners);
          applySelectedBanner(data.banners);
        }
      })
      .catch(() => undefined)
      .finally(finishBannerRequest);
    setLoadingNavigation(true);
    authenticatedFetch("/api/catalog/navigation")
      .then((response) => response.json())
      .then((data) => {
        if (Array.isArray(data.departments)) setDepartments(data.departments);
        if (Array.isArray(data.partners)) setPartnerLogos(data.partners);
      })
      .catch(() => undefined)
      .finally(() => setLoadingNavigation(false));
  }, [authReady, customer?.id, initialBannerId, bannerOnlyRoute]);
  useEffect(() => {
    if (slides.length <= 1) return;
    const delay = Math.max(6500, slidePausedUntil - Date.now());
    const timer = window.setTimeout(
      () => setSlide((current) => (current + 1) % slides.length),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [slide, slidePausedUntil, slides.length]);
  useEffect(() => {
    if (slide >= slides.length) setSlide(0);
  }, [slide, slides.length]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filteredProducts = useMemo(() => {
    if (activeBannerId > 0 && bannerOnlyRoute &&
      (!bannerRouteReady || bannerRouteMissing || (campaignCode > 0 && loadedCampaignCode !== campaignCode))) return [];
    const normalized = normalizeSearch(query.trim());
    return products.filter((product) => {
      const matchesSupplier =
        !supplierFilter || String(product.supplierId) === supplierFilter;
      const matchesDestinationSupplier =
        !destinationSupplierIds.length ||
        destinationSupplierIds.includes(product.supplierId);
      const matchesDepartment =
        !departmentFilter || product.department === departmentFilter;
      const matchesSection =
        !sectionFilter || product.section === sectionFilter;
      const matchesDestinationSection =
        !destinationSectionCodes.length ||
        destinationSectionCodes.includes(product.sectionCode);
      const matchesDestinationProduct =
        !destinationProductCodes.length ||
        destinationProductCodes.includes(product.code);
      const matchesQuery =
        !normalized ||
        normalizeSearch(`${product.name} ${product.brand} ${product.category} ${product.code}`)
          .includes(normalized);
      return (
        matchesSupplier &&
        matchesDestinationSupplier &&
        matchesDepartment &&
        matchesSection &&
        matchesDestinationSection &&
        matchesDestinationProduct &&
        matchesQuery
      );
    });
  }, [
    bannerOnlyRoute,
    bannerRouteReady,
    bannerRouteMissing,
    activeBannerId,
    campaignCode,
    loadedCampaignCode,
    departmentFilter,
    destinationProductCodes,
    destinationSectionCodes,
    destinationSupplierIds,
    products,
    query,
    sectionFilter,
    supplierFilter,
  ]);

  const supplierOptions = useMemo(
    () =>
      [
        ...new Map(
          products.map((product) => [product.supplierId, product.brand]),
        ).entries(),
      ].sort((a, b) => a[1].localeCompare(b[1], "pt-BR")),
    [products],
  );
  const selectedSupplierName = supplierOptions.find(
    ([id]) => String(id) === supplierFilter,
  )?.[1];
  const selectedDepartment = departments.find(
    (department) => department.name === departmentFilter,
  );
  const selectedSection = selectedDepartment?.sections.find(
    (section) => section.name === sectionFilter,
  );
  const headerDepartments = useMemo(
    () =>
      [...departments]
        .sort(
          (a, b) =>
            b.productCount - a.productCount ||
            a.name.localeCompare(b.name, "pt-BR"),
        )
        .slice(0, 6),
    [departments],
  );
  const contextualDepartments = useMemo(() => {
    if (!isBannerDestination) return departments;
    const allowedProducts = products.filter(
      (product) =>
        (!destinationSupplierIds.length ||
          destinationSupplierIds.includes(product.supplierId)) &&
        (!destinationSectionCodes.length ||
          destinationSectionCodes.includes(product.sectionCode)) &&
        (!destinationProductCodes.length ||
          destinationProductCodes.includes(product.code)),
    );
    const sectionCodes = new Set(
      allowedProducts.map((product) => product.sectionCode),
    );
    const departmentNames = new Set(
      allowedProducts.map((product) => product.department),
    );
    return departments.flatMap((department) => {
      if (!departmentNames.has(department.name)) return [];
      const sections = department.sections.filter((section) =>
        sectionCodes.has(section.code),
      );
      return [
        {
          ...department,
          productCount: allowedProducts.filter(
            (product) => product.department === department.name,
          ).length,
          sections,
        },
      ];
    });
  }, [
    departments,
    destinationProductCodes,
    destinationSectionCodes,
    destinationSupplierIds,
    isBannerDestination,
    products,
  ]);
  const contextualSuppliers = useMemo(
    () => supplierOptions.filter(([id]) => destinationSupplierIds.includes(id)),
    [destinationSupplierIds, supplierOptions],
  );

  const catalogRows = useMemo(() => {
    const remaining = [...filteredProducts];
    const rows: Array<{ products: Product[]; bannerBefore: Banner | null }> =
      [];
    const takeMatching = (
      predicate: (product: Product) => boolean,
      limit: number,
    ) => {
      const selected: Product[] = [];
      for (
        let index = 0;
        index < remaining.length && selected.length < limit;
      ) {
        if (predicate(remaining[index]))
          selected.push(...remaining.splice(index, 1));
        else index += 1;
      }
      return selected;
    };
    const productsPerPage = 25;
    const bannersPerPage = 2;
    const visiblePages = Math.max(1, Math.ceil(visibleCount / productsPerPage));
    for (
      let pageIndex = 0;
      remaining.length > 0 && pageIndex < visiblePages;
      pageIndex += 1
    ) {
      const pageBanners = isBannerDestination
        ? []
        : catalogBanners.slice(
            pageIndex * bannersPerPage,
            (pageIndex + 1) * bannersPerPage,
          );
      const matchesBanner = (product: Product, banner: Banner) => {
        if (banner.destinationType === "sections")
          return banner.destinationValues.includes(product.sectionCode);
        if (banner.destinationType === "products")
          return banner.destinationValues.includes(product.code);
        if (banner.destinationType === "suppliers")
          return banner.destinationValues.includes(product.supplierId);
        if (banner.destinationType === "campaigns")
          return (
            product.campaignOffers?.some((offer) =>
              banner.destinationValues.includes(offer.campaignCode),
            ) ?? false
          );
        return true;
      };
      let addedBannerGroup = false;
      for (const banner of pageBanners) {
        if (!remaining.length) break;
        const hasSpecificDestination =
          banner.destinationType !== "navigation" &&
          banner.destinationValues.length > 0;
        if (
          hasSpecificDestination &&
          !remaining.some((product) => matchesBanner(product, banner))
        )
          continue;
        const bannerProducts = hasSpecificDestination
          ? takeMatching((product) => matchesBanner(product, banner), 10)
          : remaining.splice(0, 10);
        if (!bannerProducts.length) continue;
        rows.push({ products: bannerProducts, bannerBefore: banner });
        addedBannerGroup = true;
      }
      // Se há um banner válido nesta página, somente os produtos daquele banner
      // ficam abaixo dele. Produtos gerais são exibidos apenas quando os banners
      // da página acabam, evitando que pareçam pertencer ao último banner.
      if (!addedBannerGroup) {
        let pageProducts = 0;
        while (remaining.length > 0 && pageProducts < productsPerPage) {
          const rowProducts = remaining.splice(
            0,
            Math.min(5, productsPerPage - pageProducts),
          );
          pageProducts += rowProducts.length;
          rows.push({ products: rowProducts, bannerBefore: null });
        }
      }
    }
    return rows;
  }, [catalogBanners, filteredProducts, isBannerDestination, visibleCount]);
  const displayedCatalogProductCount = catalogRows.reduce(
    (total, row) => total + row.products.length,
    0,
  );
  const cartCount = cart.length;
  const campaignQuantities = useMemo(
    () => campaignQuantitiesForCart(cart),
    [cart],
  );
  const cartTotal = cart.reduce(
    (sum, item) =>
      sum +
      (productPriceForQuantity(item, item.quantity, campaignQuantities)
        .unitPrice ?? 0) *
        item.quantity,
    0,
  );
  const minimumOrder = 200;
  const checkoutTotal = quote?.total ?? cartTotal;
  const minimumRemaining = Math.max(0, minimumOrder - cartTotal);
  const minimumProgress = Math.min(100, (cartTotal / minimumOrder) * 100);

  async function validateCartQuantity(productId: number, quantity: number) {
    if (stockChecksRef.current.has(productId)) return false;
    stockChecksRef.current.add(productId);
    setStockCheckingIds((current) => new Set(current).add(productId));
    try {
      const response = await authenticatedFetch(`/api/customer/cart/${productId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          data?.message || "Não foi possível validar o estoque agora.",
        );
      const cartResponse = await authenticatedFetch('/api/customer/cart');
      if (cartResponse.ok) setCart((await cartResponse.json()).items || []);
      return true;
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "Não foi possível validar o estoque agora.",
      );
      return false;
    } finally {
      stockChecksRef.current.delete(productId);
      setStockCheckingIds((current) => {
        const next = new Set(current);
        next.delete(productId);
        return next;
      });
    }
  }

  async function addToCart(product: Product) {
    if (!customer || product.unitPrice === null) {
      window.location.href = "/conta";
      return;
    }
    if (!customer.canOrder) {
      setToast(
        customer.commercialBlocked
          ? "Seu cadastro está bloqueado para compras. Fale com a equipe Ômega."
          : "Seu cadastro está em análise. Você poderá comprar após a aprovação da equipe Ômega.",
      );
      return;
    }
    const existing = cart.find((item) => item.id === product.id && !item.isGift);
    const nextQuantity = (existing?.quantity || 0) + product.salesMultiple;
    if (!(await validateCartQuantity(product.id, nextQuantity))) return;
    setToast(`${product.name} adicionado ao carrinho`);
  }

  async function toggleFavorite(product: Product) {
    if (!customer) {
      window.location.href = "/conta";
      return;
    }
    const isFavorite = favoriteIds.has(product.id);
    try {
      const response = await authenticatedFetch(
        `/api/customer/favorites/${product.id}`,
        { method: isFavorite ? "DELETE" : "PUT" },
      );
      const data = response.status === 204 ? null : await response.json();
      if (!response.ok)
        throw new Error(
          data?.message || "Não foi possível alterar o favorito.",
        );
      setFavoriteIds((current) => {
        const next = new Set(current);
        if (isFavorite) next.delete(product.id);
        else next.add(product.id);
        return next;
      });
      setToast(
        isFavorite
          ? `${product.name} removido dos favoritos`
          : `${product.name} adicionado aos favoritos`,
      );
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "Não foi possível alterar o favorito.",
      );
    }
  }

  async function logout() {
    await Promise.all([
      supabase.auth.signOut(),
      fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined),
      fetch("/api/staff/auth/logout", { method: "POST" }).catch(
        () => undefined,
      ),
    ]);
    window.location.reload();
  }

  function clearFilters() {
    setQuery("");
    setSupplierFilter("");
    setDepartmentFilter("");
    setSectionFilter("");
    setDestinationSupplierIds([]);
    setDestinationSectionCodes([]);
    setDestinationProductCodes([]);
    setCampaignCode(0);
    setActiveBannerId(0);
    setCatalogMode("featured");
    if (window.location.search) window.history.replaceState({}, "", "/");
  }

  function clearDestinationFilters() {
    setDestinationSupplierIds([]);
    setDestinationSectionCodes([]);
    setDestinationProductCodes([]);
    setCampaignCode(0);
    setActiveBannerId(0);
  }

  function resetBannerRefinements() {
    setQuery("");
    setSupplierFilter(
      destinationSupplierIds.length === 1 ? String(destinationSupplierIds[0]) : "",
    );
    setDepartmentFilter("");
    setSectionFilter("");
    setExpandedDepartment("");
  }

  function refineBannerDepartment(name: string) {
    setQuery("");
    setSupplierFilter(
      destinationSupplierIds.length === 1 ? String(destinationSupplierIds[0]) : "",
    );
    setDepartmentFilter(name);
    setSectionFilter("");
    setExpandedDepartment(name);
    setVisibleCount(25);
  }

  function refineBannerSection(departmentName: string, sectionName: string) {
    setQuery("");
    setDepartmentFilter(departmentName);
    setSectionFilter(sectionName);
    setExpandedDepartment(departmentName);
    setVisibleCount(25);
  }

  function selectSlideManually(nextSlide: number) {
    if (slides.length <= 1) return;
    setSlide((nextSlide + slides.length) % slides.length);
    setSlidePausedUntil(Date.now() + 10000);
  }

  function startHeroSwipe(event: React.TouchEvent<HTMLElement>) {
    const touch = event.touches[0];
    heroTouchStartRef.current = touch
      ? { x: touch.clientX, y: touch.clientY }
      : null;
  }

  function finishHeroSwipe(event: React.TouchEvent<HTMLElement>) {
    const start = heroTouchStartRef.current;
    const touch = event.changedTouches[0];
    heroTouchStartRef.current = null;
    if (!start || !touch) return;
    const horizontal = touch.clientX - start.x;
    const vertical = touch.clientY - start.y;
    if (
      Math.abs(horizontal) < 45 ||
      Math.abs(horizontal) <= Math.abs(vertical) * 1.15
    )
      return;
    suppressHeroClickRef.current = true;
    selectSlideManually(slide + (horizontal < 0 ? 1 : -1));
    window.setTimeout(() => {
      suppressHeroClickRef.current = false;
    }, 300);
  }

  function selectSearch(value: string) {
    setQuery(value);
    setSupplierFilter("");
    setDepartmentFilter("");
    setSectionFilter("");
    setExpandedDepartment("");
    clearDestinationFilters();
    setCatalogMode("featured");
    setVisibleCount(25);
    window.history.replaceState(
      {},
      "",
      value ? `/?busca=${encodeURIComponent(value)}#produtos` : "/",
    );
  }

  function selectSupplier(value: string) {
    if (!value) {
      clearFilters();
      return;
    }
    setQuery("");
    setSupplierFilter(value);
    setDepartmentFilter("");
    setSectionFilter("");
    setExpandedDepartment("");
    clearDestinationFilters();
    setCatalogMode("featured");
    setVisibleCount(25);
    window.history.replaceState({}, "", `/?fornecedor=${value}#produtos`);
  }

  function selectDepartment(name: string) {
    setQuery("");
    setSupplierFilter("");
    clearDestinationFilters();
    setCatalogMode("featured");
    setDepartmentFilter(name);
    setSectionFilter("");
    setExpandedDepartment(name);
    setVisibleCount(25);
    setMenuOpen(false);
    window.history.replaceState(
      {},
      "",
      `/?departamento=${encodeURIComponent(name)}#produtos`,
    );
    window.setTimeout(
      () =>
        productsRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        }),
      50,
    );
  }

  function selectSection(departmentName: string, sectionName: string) {
    setQuery("");
    setSupplierFilter("");
    clearDestinationFilters();
    setCatalogMode("featured");
    setDepartmentFilter(departmentName);
    setSectionFilter(sectionName);
    setVisibleCount(25);
    setMenuOpen(false);
    window.history.replaceState(
      {},
      "",
      `/?departamento=${encodeURIComponent(departmentName)}&secao=${encodeURIComponent(sectionName)}#produtos`,
    );
    window.setTimeout(
      () =>
        productsRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        }),
      50,
    );
  }

  // Parceiros sempre abrem a página exclusiva do fornecedor (mesmo destino de /parceiros).
  function selectPartner(partner: Partner) {
    window.location.href = `/?fornecedor=${partner.supplierId}#produtos`;
  }

  function bannerTarget(banner: Banner) {
    if (banner.destinationType !== "navigation")
      return `/?banner=${banner.id}#produtos`;
    return banner.navigationPath || "/#produtos";
  }

  async function changeQuantity(id: number, delta: number) {
    const item = cart.find((candidate) => candidate.id === id && !candidate.isGift);
    if (!item) return false;
    const nextQuantity = item.quantity + delta;
    if (nextQuantity <= 0) {
      return removeFromCart(id);
    }
    if (!(await validateCartQuantity(id, nextQuantity))) return false;
    return true;
  }

  async function setQuantity(id: number, quantity: number) {
    const item = cart.find((candidate) => candidate.id === id && !candidate.isGift);
    if (!item) return false;
    if (quantity === item.quantity) return true;
    if (!(await validateCartQuantity(id, quantity))) return false;
    return true;
  }

  async function removeFromCart(id: number) {
    if (stockChecksRef.current.has(id)) return false;
    stockChecksRef.current.add(id);
    setStockCheckingIds((current) => new Set(current).add(id));
    try {
      const response = await authenticatedFetch(`/api/customer/cart/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.message || "Não foi possível remover o item.");
      }
      const cartResponse = await authenticatedFetch('/api/customer/cart');
      if (cartResponse.ok) setCart((await cartResponse.json()).items || []);
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Não foi possível remover o item.");
      return false;
    } finally {
      stockChecksRef.current.delete(id);
      setStockCheckingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  function showBestSellers() {
    setCatalogMode("bestsellers");
    setMenuOpen(false);
    window.setTimeout(
      () =>
        productsRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        }),
      50,
    );
  }

  // Sem plano informado, a API escolhe o plano de menor total para o cliente.
  async function requestQuote(
    paymentPlan?: string,
    couponCode = appliedCouponCode,
  ) {
    if (!cart.length) return;
    setQuoting(true);
    setOrderError("");
    try {
      const response = await authenticatedFetch("/api/customer/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentPlan,
          couponCode,
          items: cart.filter((item) => !item.isGift).map((item) => ({
            productId: item.id,
            quantity: item.quantity,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      setQuote(data);
      setAppliedCouponCode(couponCode);
    } catch (error) {
      setQuote(null);
      setOrderError(
        error instanceof Error
          ? error.message
          : "Não foi possível calcular o pedido.",
      );
    } finally {
      setQuoting(false);
    }
  }

  async function beginCheckout() {
    if (!customer) {
      window.location.href = "/conta?return=checkout";
      return;
    }
    if (!customer.canOrder) {
      setCartOpen(false);
      setToast(
        customer.commercialBlocked
          ? "Seu cadastro está bloqueado para compras. Fale com a equipe Ômega."
          : "Seu cadastro ainda está em análise e não pode enviar pedidos.",
      );
      return;
    }
    setLoadingConditions(true);
    setOrderError("");
    try {
      const response = await authenticatedFetch(
        "/api/customer/commercial-conditions",
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      setCommercialConditions(data);
      setQuote(null);
      setCouponDraft("");
      setAppliedCouponCode("");
      setCartOpen(false);
      setCheckoutOpen(true);
      void requestQuote();
    } catch (error) {
      setOrderError(
        error instanceof Error
          ? error.message
          : "Não foi possível consultar suas condições comerciais.",
      );
    } finally {
      setLoadingConditions(false);
    }
  }

  async function submitOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customer) return;
    setSendingOrder(true);
    setOrderError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await authenticatedFetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: customer.id,
          paymentPlan: form.get("paymentPlan"),
          couponCode: appliedCouponCode,
          notes: form.get("notes"),
          items: cart.filter((item) => !item.isGift).map((item) => ({
            productId: item.id,
            quantity: item.quantity,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      setOrderNumber(data.order.number);
      setCart([]);
      setCheckoutOpen(false);
    } catch (error) {
      setOrderError(
        error instanceof Error
          ? error.message
          : "Não foi possível enviar o pedido.",
      );
    } finally {
      setSendingOrder(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="container topbar-inner">
          <p aria-busy={!authReady}>
            {!authReady ? (
              <>&nbsp;</>
            ) : customer ? (
              <>
                Bem-vindo(a),{" "}
                <strong>{customer.tradeName || customer.legalName}</strong>
              </>
            ) : staffUser ? (
              <>
                Sessão de gestão: <strong>{staffUser.name}</strong>
              </>
            ) : (
              <>
                Tudo o que você precisa, <strong>sempre por perto.</strong>
              </>
            )}
          </p>
          <div className="topbar-links">
            <span>
              <MapPin size={15} /> Entregamos em todo o Ceará
            </span>
            <a href={whatsappUrl} target="_blank" rel="noreferrer">
              Central de ajuda
            </a>
          </div>
        </div>
      </div>
      <header className="site-header">
        <div className="container header-main">
          <button
            className="mobile-menu-btn icon-btn"
            aria-label="Abrir menu"
            onClick={() => setMenuOpen(true)}
          >
            <Menu />
          </button>
          <a
            className="logo"
            href="/"
            aria-label="Ômega Distribuidora — início sem filtros"
          >
            <img src="/assets/omega-logo.png" alt="Ômega Distribuidora" />
          </a>
          <label className="search-box">
            <Search size={21} />
            <input
              value={query}
              onChange={(event) => selectSearch(event.target.value)}
              onFocus={() =>
                productsRef.current?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                })
              }
              placeholder="Busque produtos, marcas ou código"
              aria-label="Buscar produtos"
            />
            {query && (
              <button
                onClick={() => selectSearch("")}
                aria-label="Limpar busca"
              >
                <X size={18} />
              </button>
            )}
          </label>
          <a
            className="account-button"
            href={staffUser ? "/gestao" : customer ? "/pedidos" : "/conta"}
          >
            <CircleUserRound />
            <span>
              <small>
                {staffUser
                  ? "Painel interno"
                  : customer
                    ? "Meus pedidos"
                    : "Área do cliente"}
              </small>
              <strong>
                {staffUser
                  ? `${staffUser.name} · ${staffUser.role}`
                  : customer
                    ? `Bem-vindo(a), ${customer.tradeName || customer.legalName}`
                    : "Entrar ou cadastrar"}
              </strong>
            </span>
          </a>
          {(customer || staffUser) && (
            <button
              className="logout-button"
              onClick={logout}
              aria-label="Sair da conta"
              title="Sair da conta"
            >
              <LogOut size={19} />
              <span>Sair</span>
            </button>
          )}
          <button
            className="cart-button"
            onClick={() => setCartOpen(true)}
            aria-label={`Abrir carrinho com ${cartCount} ${cartCount === 1 ? "item" : "itens"}`}
          >
            <span className="cart-icon">
              <ShoppingCart />
              {cartCount > 0 && <b>{cartCount}</b>}
            </span>
            <span>
              <small>Meu carrinho</small>
              <strong>{money.format(cartTotal)}</strong>
            </span>
          </button>
        </div>
        <nav className="main-nav" aria-label="Departamentos e seções">
          <div className="container nav-inner department-nav">
            <button
              className="categories-button"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={19} /> Departamentos <ChevronDown size={17} />
            </button>
            {loadingNavigation ? (
              <div
                className="nav-skeleton"
                aria-label="Carregando departamentos"
                aria-busy="true"
              >
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton key={index} />
                ))}
              </div>
            ) : (
              headerDepartments.map((department) => (
                <div
                  className={`department-nav-item${closedDepartmentMenu === department.name ? " closed" : ""}`}
                  onMouseLeave={() => setClosedDepartmentMenu("")}
                  key={department.code || department.name}
                >
                  <button
                    className={
                      departmentFilter === department.name ? "active" : ""
                    }
                    onClick={(event) => {
                      selectDepartment(department.name);
                      setClosedDepartmentMenu(department.name);
                      event.currentTarget.blur();
                    }}
                  >
                    {formatCatalogName(department.name)}
                    <ChevronDown size={14} />
                  </button>
                  <div className="department-dropdown">
                    <button
                      className="department-all"
                      onClick={(event) => {
                        selectDepartment(department.name);
                        setClosedDepartmentMenu(department.name);
                        event.currentTarget.blur();
                      }}
                    >
                      Ver todos em {formatCatalogName(department.name)}
                    </button>
                    <div>
                      {department.sections.map((section) => (
                        <button
                          key={`${department.name}-${section.code || section.name}`}
                          onClick={(event) => {
                            selectSection(department.name, section.name);
                            setClosedDepartmentMenu(department.name);
                            event.currentTarget.blur();
                          }}
                        >
                          {formatCatalogName(section.name)}
                          <small>{section.productCount}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))
            )}
            <a className="nav-campaigns" href="/campanhas">
              Clube de Ofertas
            </a>
            <div
              className={`partners-nav-item${partnersMenuClosed ? " closed" : ""}`}
              onMouseLeave={() => setPartnersMenuClosed(false)}
            >
              <a href="/parceiros">Parceiros</a>
              {partnerLogos.length > 0 && (
                <div className="partners-dropdown">
                  {partnerLogos.map((partner) => (
                    <button
                      key={partner.supplierId}
                      onClick={(event) => {
                        selectPartner(partner);
                        setPartnersMenuClosed(true);
                        event.currentTarget.blur();
                      }}
                    >
                      <img src={partner.logo} alt="" />
                      <span>{partner.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <a
              className="nav-support"
              href={whatsappUrl}
              target="_blank"
              rel="noreferrer"
            >
              Atendimento
            </a>
          </div>
        </nav>
      </header>

      {customer?.canOrder && customer.pricesPending && (
        <div className="store-pending-banner">
          <LoaderCircle className="spin" />
          <div>
            <strong>Carregando seus preços</strong>
            <span>
              Estamos buscando as condições do seu cadastro. Isso leva cerca de
              1 minuto e a página atualiza sozinha.
            </span>
          </div>
        </div>
      )}

      {customer && !customer.canOrder && (
        <div className="store-pending-banner">
          <LoaderCircle />
          <div>
            <strong>
              {customer.commercialBlocked
                ? "Cadastro bloqueado para compras"
                : "Cadastro em análise"}
            </strong>
            <span>
              {customer.commercialBlocked
                ? "Entre em contato com a equipe Ômega para verificar a situação do seu cadastro."
                : "Você já pode navegar pelo catálogo. Preços e pedidos são liberados após a aprovação do seu cadastro."}
            </span>
          </div>
          <a href="/pedidos">Ver meu cadastro</a>
        </div>
      )}

      <main id="top">
        {!isBannerDestination &&
          (loadingBanners ? (
            <HeroSkeleton />
          ) : slides.length > 0 ? (
            <section
              className="hero"
              aria-label="Destaques"
              onTouchStart={startHeroSwipe}
              onTouchEnd={finishHeroSwipe}
              onTouchCancel={() => {
                heroTouchStartRef.current = null;
              }}
            >
              <div
                className="hero-track"
                style={{ transform: `translate3d(-${slide * 100}%, 0, 0)` }}
              >
                {slides.map((item) => (
                  <a
                    key={item.id}
                    className="hero-slide"
                    href={bannerTarget(item)}
                    onClick={(event) => {
                      if (suppressHeroClickRef.current) event.preventDefault();
                    }}
                  >
                    <picture>
                      <source media="(max-width: 760px)" srcSet={item.mobileImageUrl || item.imageUrl} />
                      <img src={item.imageUrl} alt={item.altText} draggable="false" />
                    </picture>
                  </a>
                ))}
              </div>
              {slides.length > 1 && (
                <>
                  <button
                    className="slider-arrow prev"
                    aria-label="Banner anterior"
                    onClick={() => selectSlideManually(slide - 1)}
                  >
                    <ChevronLeft />
                  </button>
                  <button
                    className="slider-arrow next"
                    aria-label="Próximo banner"
                    onClick={() => selectSlideManually(slide + 1)}
                  >
                    <ChevronRight />
                  </button>
                  <div className="slider-dots">
                    {slides.map((item, index) => (
                      <button
                        key={item.id}
                        className={index === slide ? "active" : ""}
                        onClick={() => selectSlideManually(index)}
                        aria-label={`Ir para banner ${index + 1}`}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
          ) : null)}

        {!isBannerDestination && !query && !supplierFilter && !departmentFilter && !sectionFilter && catalogMode === 'featured' && featuredProducts.length > 0 && (
          <section className="container featured-products" aria-label="Produtos em destaque">
            <div className="product-grid">
              {featuredProducts.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  addToCart={addToCart}
                  changeQuantity={changeQuantity}
                  setQuantity={setQuantity}
                  toggleFavorite={toggleFavorite}
                  favorite={favoriteIds.has(product.id)}
                  quantity={cart.find((item) => item.id === product.id && !item.isGift)?.quantity ?? 0}
                  authenticated={Boolean(customer)}
                  canOrder={Boolean(customer?.canOrder)}
                  commercialBlocked={Boolean(customer?.commercialBlocked)}
                  checkingStock={stockCheckingIds.has(product.id)}
                  campaignQuantities={campaignQuantities}
                  onInvalid={setToast}
                />
              ))}
            </div>
          </section>
        )}

        <section
          className={`container products-section ${selectedDepartment || isBannerDestination ? "has-taxonomy" : "catalog-home"}`}
          id="produtos"
          ref={productsRef}
        >
          {(selectedDepartment || isBannerDestination) && (
            <aside
              className="taxonomy-sidebar"
              aria-label={
                isBannerDestination
                  ? "Filtros dos produtos"
                  : "Departamentos e seções"
              }
            >
              <div className="taxonomy-sidebar-title">
                <SlidersHorizontal size={18} />
                <div>
                  <strong>
                    {isBannerDestination ? "Filtros" : "Departamentos"}
                  </strong>
                  <span>
                    {isBannerDestination
                      ? "Refine os produtos"
                      : destinationSupplierIds.length > 1
                        ? "Escolha um fornecedor"
                        : "Escolha uma seção"}
                  </span>
                </div>
              </div>
              <button
                className={
                  !departmentFilter &&
                  (!destinationSupplierIds.length ||
                    !supplierFilter ||
                    destinationSupplierIds.length === 1)
                    ? "active taxonomy-all"
                    : "taxonomy-all"
                }
                onClick={
                  isBannerDestination ? resetBannerRefinements : clearFilters
                }
              >
                {isBannerDestination
                  ? "Todos os resultados"
                  : "Todos os produtos"}
              </button>
              {isBannerDestination && destinationSupplierIds.length > 1 && (
                <div className="taxonomy-suppliers">
                  {contextualSuppliers.map(([id, name]) => (
                    <button
                      className={supplierFilter === String(id) ? "active" : ""}
                      key={id}
                      onClick={() => {
                        setSupplierFilter(String(id));
                        setDepartmentFilter("");
                        setSectionFilter("");
                        setExpandedDepartment("");
                      }}
                    >
                      {formatCatalogName(name)}
                    </button>
                  ))}
                </div>
              )}
              <div className="taxonomy-list">
                {(isBannerDestination
                  ? contextualDepartments
                  : departments.filter(
                      (department) => department.name === departmentFilter,
                    )
                ).map((department) => {
                  // Fora dos destinos de banner, a lateral mostra só o departamento escolhido, já aberto.
                  const open =
                    expandedDepartment === department.name ||
                    !isBannerDestination;
                  return (
                    <div
                      className={`taxonomy-department ${open ? "open" : ""}`}
                      key={department.code || department.name}
                    >
                      <button
                        className={
                          departmentFilter === department.name && !sectionFilter
                            ? "active"
                            : ""
                        }
                        onClick={() => {
                          if (!isBannerDestination)
                            selectDepartment(department.name);
                          else if (departmentFilter === department.name)
                            setExpandedDepartment(open ? "" : department.name);
                          else refineBannerDepartment(department.name);
                        }}
                      >
                        <span>
                          {formatCatalogName(department.name)}
                          <small>{department.productCount} produtos</small>
                        </span>
                        <ChevronDown size={17} />
                      </button>
                      {open && (
                        <div className="taxonomy-sections">
                          {department.sections.map((section) => (
                            <button
                              className={
                                sectionFilter === section.name ? "active" : ""
                              }
                              key={`${department.name}-${section.code || section.name}`}
                              onClick={() =>
                                isBannerDestination
                                  ? refineBannerSection(
                                      department.name,
                                      section.name,
                                    )
                                  : selectSection(department.name, section.name)
                              }
                            >
                              <span>{formatCatalogName(section.name)}</span>
                              <small>{section.productCount}</small>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
          <div className="section-heading">
            <div>
              <h1>
                {campaignCode > 0
                  ? activeCampaign?.code === campaignCode ? activeCampaign.name || "Campanha" : "Campanha"
                  : isBannerDestination
                    ? bannerPageTitle || (selectedSection
                        ? formatCatalogName(selectedSection.name)
                        : selectedDepartment
                          ? formatCatalogName(selectedDepartment.name)
                          : selectedSupplierName
                            ? `Produtos ${selectedSupplierName}`
                            : "Produtos")
                  : selectedSupplierName
                    ? `Produtos ${selectedSupplierName}`
                    : query
                      ? `Resultados para “${query}”`
                      : selectedSection
                        ? formatCatalogName(selectedSection.name)
                        : selectedDepartment
                          ? formatCatalogName(selectedDepartment.name)
                          : catalogMode === "bestsellers"
                            ? "Mais vendidos nos últimos 30 dias"
                            : "Todos os produtos"}
              </h1>
              {campaignCode > 0 && activeCampaign?.code === campaignCode && activeCampaign.description && (
                <p className="campaign-page-description">{activeCampaign.description}</p>
              )}
              {campaignCode > 0 && (
                <p className="taxonomy-breadcrumb">
                  <a href="/campanhas">Clube de Ofertas</a> → {activeCampaign?.code === campaignCode ? activeCampaign.name || "Campanha" : "Campanha"}
                </p>
              )}
              {selectedDepartment && (
                <p className="taxonomy-breadcrumb">
                  {formatCatalogName(selectedDepartment.name)}
                  {selectedSection
                    ? ` → ${formatCatalogName(selectedSection.name)}`
                    : ""}
                </p>
              )}
            </div>
            <span className="result-count">
              {filteredProducts.length}{" "}
              {filteredProducts.length === 1 ? "produto" : "produtos"}
            </span>
          </div>
          {!isBannerDestination && (
            <div className="catalog-filters">
              <span className="filter-title">
                <SlidersHorizontal size={18} /> Refinar catálogo
              </span>
              <label>
                Fornecedor
                <select
                  value={supplierFilter}
                  onChange={(event) => selectSupplier(event.target.value)}
                >
                  <option value="">Todos os fornecedores</option>
                  {supplierOptions.map(([id, name]) => (
                    <option value={id} key={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Departamento
                <select
                  value={departmentFilter}
                  onChange={(event) =>
                    event.target.value
                      ? selectDepartment(event.target.value)
                      : clearFilters()
                  }
                >
                  <option value="">Todos os departamentos</option>
                  {departments.map((department) => (
                    <option
                      value={department.name}
                      key={department.code || department.name}
                    >
                      {formatCatalogName(department.name)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Seção
                <select
                  value={sectionFilter}
                  onChange={(event) =>
                    event.target.value
                      ? selectSection(departmentFilter, event.target.value)
                      : selectDepartment(departmentFilter)
                  }
                  disabled={!selectedDepartment}
                >
                  <option value="">Todas as seções</option>
                  {selectedDepartment?.sections.map((section) => (
                    <option
                      value={section.name}
                      key={section.code || section.name}
                    >
                      {formatCatalogName(section.name)}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={clearFilters}>Limpar filtros</button>
            </div>
          )}
          {loadingProducts ? (
            <div className="catalog-loading">
              <LoaderCircle className="spin" />
              <span>Carregando produtos...</span>
            </div>
          ) : productsError ? (
            <div className="empty-results">
              <ImageOff size={36} />
              <h2>Catálogo indisponível</h2>
              <p>{productsError}</p>
              <button
                className="primary-button"
                onClick={() => window.location.reload()}
              >
                Tentar novamente
              </button>
            </div>
          ) : catalogRows.length > 0 ? (
            <>
              <div className="catalog-flow">
                {catalogRows.map((row, rowIndex) => (
                  <div className="catalog-row-group" key={`row-${rowIndex}`}>
                    {row.bannerBefore && (
                      <a
                        className="catalog-banner"
                        href={bannerTarget(row.bannerBefore)}
                      >
                        <picture>
                          <source media="(max-width: 760px)" srcSet={row.bannerBefore.mobileImageUrl || row.bannerBefore.imageUrl} />
                          <img src={row.bannerBefore.imageUrl} alt={row.bannerBefore.altText} />
                        </picture>
                      </a>
                    )}
                    <div className="product-grid">
                      {row.products.map((product, productIndex) => (
                        <ProductCard
                          key={product.id}
                          product={product}
                          rank={
                            catalogMode === "bestsellers"
                              ? rowIndex * 5 + productIndex + 1
                              : undefined
                          }
                          addToCart={addToCart}
                          changeQuantity={changeQuantity}
                          setQuantity={setQuantity}
                          toggleFavorite={toggleFavorite}
                          favorite={favoriteIds.has(product.id)}
                          quantity={
                            cart.find((item) => item.id === product.id && !item.isGift)
                              ?.quantity ?? 0
                          }
                          authenticated={Boolean(customer)}
                          canOrder={Boolean(customer?.canOrder)}
                          commercialBlocked={Boolean(
                            customer?.commercialBlocked,
                          )}
                          checkingStock={stockCheckingIds.has(product.id)}
                          campaignQuantities={campaignQuantities}
                          onInvalid={setToast}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {displayedCatalogProductCount < filteredProducts.length && (
                <button
                  className="load-more"
                  onClick={() => setVisibleCount((count) => count + 25)}
                >
                  Ver mais produtos <ArrowRight size={18} />
                </button>
              )}
            </>
          ) : (
            <div className="empty-results">
              <Search size={36} />
              <h2>Nenhum produto encontrado</h2>
              <p>Tente combinar outros filtros ou explore todo o catálogo.</p>
              <button
                className="primary-button"
                onClick={
                  isBannerDestination ? resetBannerRefinements : clearFilters
                }
              >
                Limpar filtros
              </button>
            </div>
          )}
        </section>

        {!isBannerDestination && partnerLogos.length > 0 && (
          <section className="brands-section" id="parceiros">
            <div className="container">
              <div className="section-heading">
                <div>
                  <h2>Nossos parceiros</h2>
                  <p>
                    Selecione uma marca para ver todos os produtos desse
                    fornecedor.
                  </p>
                </div>
              </div>
            </div>
            <div className="brands-carousel">
              <div className="brands-track">
                {[0, 1].map((copy) => (
                  <div
                    className="brands-loop"
                    aria-hidden={copy === 1 || undefined}
                    key={copy}
                  >
                    {partnerLogos.map((partner) => (
                      <button
                        className="brand-card"
                        onClick={() => selectPartner(partner)}
                        key={`${copy}-${partner.supplierId}`}
                        tabIndex={copy === 1 ? -1 : undefined}
                        aria-label={`Filtrar produtos de ${partner.name}`}
                      >
                        <img
                          src={partner.logo}
                          alt={copy === 0 ? `Logo ${partner.name}` : ""}
                          loading="lazy"
                        />
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </main>

      <footer>
        <div className="container footer-grid">
          <div className="footer-brand">
            <img src="/assets/omega-logo.png" alt="Ômega Distribuidora" />
            <p>Distribuindo mais do que produtos: parcerias de sucesso.</p>
          </div>
          <div>
            <strong>Institucional</strong>
            <a href="/sobre">Sobre a Ômega</a>
            <a href="/parceiros">Nossos parceiros</a>
            <a href={whatsappUrl} target="_blank" rel="noreferrer">
              Fale conosco
            </a>
          </div>
          <div>
            <strong>Atendimento</strong>
            <span>Segunda a sexta, 8h às 17h</span>
            <a href={whatsappUrl} target="_blank" rel="noreferrer">
              WhatsApp: (85) 9202-0207
            </a>
          </div>
          <div>
            <strong>Compra protegida</strong>
            <p className="security-copy">
              <LockKeyhole size={19} /> Ambiente seguro para seus pedidos.
            </p>
          </div>
        </div>
        <div className="container footer-bottom">
          <span>© 2026 Ômega Distribuidora. Todos os direitos reservados.</span>
          <span>Preços unitários sujeitos à confirmação comercial.</span>
        </div>
      </footer>

      {customer?.canOrder && (
        <button
          className={`minimum-order-widget ${minimumRemaining === 0 ? "complete" : ""}`}
          onClick={() => setCartOpen(true)}
          aria-label={`Carrinho em ${money.format(cartTotal)} de um pedido mínimo de ${money.format(minimumOrder)}`}
        >
          <span>
            <ShoppingCart size={18} /> Pedido mínimo
          </span>
          <strong>
            {money.format(cartTotal)}{" "}
            <small>/ {money.format(minimumOrder)}</small>
          </strong>
          <i>
            <b style={{ width: `${minimumProgress}%` }} />
          </i>
          <em>
            {minimumRemaining > 0
              ? `Faltam ${money.format(minimumRemaining)}`
              : "Mínimo atingido"}
          </em>
        </button>
      )}

      {menuOpen && (
        <div className="overlay" onMouseDown={() => setMenuOpen(false)}>
          <aside
            className="side-panel menu-panel department-drawer"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="drawer-heading">
              <div>
                <span className="eyebrow">CATÁLOGO</span>
                <h2>Departamentos</h2>
              </div>
              <button className="icon-btn" onClick={() => setMenuOpen(false)}>
                <X />
              </button>
            </div>
            <button
              className={
                !departmentFilter
                  ? "active drawer-all-products"
                  : "drawer-all-products"
              }
              onClick={() => {
                clearFilters();
                setMenuOpen(false);
                window.setTimeout(
                  () =>
                    productsRef.current?.scrollIntoView({ behavior: "smooth" }),
                  50,
                );
              }}
            >
              <Store size={20} />
              Todos os produtos
              <ChevronRight size={18} />
            </button>
            <div className="drawer-taxonomy">
              {departments.map((department) => {
                const open = expandedDepartment === department.name;
                return (
                  <div
                    className="drawer-department"
                    key={department.code || department.name}
                  >
                    <button
                      className={
                        departmentFilter === department.name && !sectionFilter
                          ? "active"
                          : ""
                      }
                      onClick={() =>
                        setExpandedDepartment(open ? "" : department.name)
                      }
                    >
                      <span>
                        {formatCatalogName(department.name)}
                        <small>{department.productCount} produtos</small>
                      </span>
                      <ChevronDown
                        className={open ? "rotated" : ""}
                        size={18}
                      />
                    </button>
                    {open && (
                      <div>
                        {
                          <button
                            className="drawer-department-all"
                            onClick={() => selectDepartment(department.name)}
                          >
                            Todos em {formatCatalogName(department.name)}
                          </button>
                        }
                        {department.sections.map((section) => (
                          <button
                            className={
                              sectionFilter === section.name ? "active" : ""
                            }
                            key={`${department.name}-${section.code || section.name}`}
                            onClick={() =>
                              selectSection(department.name, section.name)
                            }
                          >
                            {formatCatalogName(section.name)}
                            <small>{section.productCount}</small>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <a
              className="drawer-partners drawer-campaigns"
              href="/campanhas"
              onClick={() => setMenuOpen(false)}
            >
              Clube de Ofertas
              <ChevronRight size={18} />
            </a>
            <a
              className="drawer-partners"
              href="/parceiros"
              onClick={() => setMenuOpen(false)}
            >
              Parceiros
              <ChevronRight size={18} />
            </a>
            <a
              className="drawer-partners drawer-login"
              href={staffUser ? "/gestao" : customer ? "/pedidos" : "/conta"}
              onClick={() => setMenuOpen(false)}
            >
              <CircleUserRound size={20} />
              <span>
                {staffUser
                  ? "Painel interno"
                  : customer
                    ? "Minha conta"
                    : "Entrar ou cadastrar"}
              </span>
              <ChevronRight size={18} />
            </a>
            {(customer || staffUser) && (
              <button className="menu-logout" onClick={logout}>
                <LogOut size={20} />
                Sair da conta
              </button>
            )}
          </aside>
        </div>
      )}

      {cartOpen && (
        <div className="overlay" onMouseDown={() => setCartOpen(false)}>
          <aside
            className="side-panel cart-panel"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="drawer-heading">
              <div>
                <span className="eyebrow">SEU PEDIDO</span>
                <h2>Meu carrinho</h2>
              </div>
              <button className="icon-btn" onClick={() => setCartOpen(false)}>
                <X />
              </button>
            </div>
            {cart.length === 0 ? (
              <div className="empty-cart">
                <span>
                  <ShoppingCart />
                </span>
                <h3>Seu carrinho está vazio</h3>
                <p>
                  Adicione produtos do catálogo para montar seu pedido.
                </p>
                <button
                  className="primary-button"
                  onClick={() => setCartOpen(false)}
                >
                  Explorar produtos
                </button>
              </div>
            ) : (
              <>
                <div className="cart-items">
                  {cart.map((item) => {
                    const price = productPriceForQuantity(
                      item,
                      item.quantity,
                      campaignQuantities,
                    );
                    return (
                      <div className="cart-item" key={item.isGift ? `gift-${item.giftCampaignCode}-${item.id}` : item.id}>
                        <div className="cart-product-image">
                          {item.image ? (
                            <img src={item.image} alt="" />
                          ) : (
                            <ImageOff />
                          )}
                        </div>
                        <div className="cart-product-info">
                          <strong>{item.name}</strong>
                          <small>{item.isGift ? `Brinde da campanha ${item.giftCampaignName || item.giftCampaignCode}` : `Múltiplo de ${item.salesMultiple} unidades`}</small>
                          <span>
                            {unitMoney.format(price.unitPrice ?? 0)} / unidade
                            {!item.isGift && price.discountPercent > 0
                              ? ` · ${price.discountPercent}% de desconto`
                              : ""}
                          </span>
                          {!item.isGift && <div className="quantity-control">
                            <button
                              disabled={stockCheckingIds.has(item.id)}
                              onClick={() =>
                                changeQuantity(item.id, -item.salesMultiple)
                              }
                              aria-label={`Remover ${item.salesMultiple} unidades`}
                            >
                              <Minus size={15} />
                            </button>
                            <CartQuantityField
                              item={item}
                              onChange={setQuantity}
                              onInvalid={(message) => setToast(message)}
                              disabled={stockCheckingIds.has(item.id)}
                            />
                            <button
                              disabled={stockCheckingIds.has(item.id)}
                              onClick={() =>
                                changeQuantity(item.id, item.salesMultiple)
                              }
                              aria-label={`Adicionar ${item.salesMultiple} unidades`}
                            >
                              <Plus size={15} />
                            </button>
                            <button
                              className="remove-item"
                              onClick={() => removeFromCart(item.id)}
                              aria-label="Remover item"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="cart-summary">
                  <div>
                    <span>Subtotal estimado</span>
                    <strong>{money.format(cartTotal)}</strong>
                  </div>
                  <div
                    className={`cart-minimum ${minimumRemaining === 0 ? "complete" : ""}`}
                  >
                    <span>
                      {minimumRemaining > 0
                        ? `Adicione mais ${money.format(minimumRemaining)} para atingir o mínimo.`
                        : "Pedido mínimo atingido."}
                    </span>
                    <i>
                      <b style={{ width: `${minimumProgress}%` }} />
                    </i>
                  </div>
                  <p>
                    Os preços mostrados são do seu melhor plano de pagamento; o
                    total final depende do plano escolhido ao finalizar. O frete
                    é confirmado pela nossa equipe.
                  </p>
                  <button
                    className="checkout-button"
                    onClick={beginCheckout}
                    disabled={minimumRemaining > 0 || loadingConditions}
                  >
                    {loadingConditions ? (
                      <LoaderCircle className="spin" />
                    ) : minimumRemaining > 0 ? (
                      `Mínimo de ${money.format(minimumOrder)}`
                    ) : (
                      "Finalizar pedido"
                    )}{" "}
                    {!loadingConditions && <ArrowRight size={19} />}
                  </button>
                  {orderError && (
                    <span className="field-error cart-condition-error">
                      {orderError}
                    </span>
                  )}
                  <button
                    className="keep-shopping"
                    onClick={() => setCartOpen(false)}
                  >
                    Continuar comprando
                  </button>
                </div>
              </>
            )}
          </aside>
        </div>
      )}

      {checkoutOpen && customer && commercialConditions && (
        <div
          className="overlay modal-overlay"
          onMouseDown={() => setCheckoutOpen(false)}
        >
          <div
            className="checkout-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="drawer-heading">
              <div>
                <span className="eyebrow">CONFIRMAR PEDIDO</span>
                <h2>Identificação do cliente</h2>
              </div>
              <button
                className="icon-btn"
                onClick={() => setCheckoutOpen(false)}
              >
                <X />
              </button>
            </div>
            <form onSubmit={submitOrder}>
              <div className="checkout-customer">
                <CircleUserRound />
                <div>
                  <strong>{customer.tradeName || customer.legalName}</strong>
                  <span>
                    {formatDocument(customer.document)} · {customer.email}
                  </span>
                </div>
                <a href="/conta">Alterar</a>
              </div>
              <label>
                Plano de pagamento
                <select
                  name="paymentPlan"
                  value={quote?.paymentPlan.code ?? ""}
                  onChange={(event) => requestQuote(event.target.value)}
                  disabled={quoting}
                  required
                >
                  {!quote && (
                    <option value="" disabled>
                      Calculando...
                    </option>
                  )}
                  {(
                    quote?.planTotals ??
                    commercialConditions.paymentPlans.map((plan) => ({
                      ...plan,
                      total: null,
                    }))
                  ).map((plan) => (
                    <option
                      key={plan.code}
                      value={plan.code}
                      disabled={quote !== null && plan.total === null}
                    >
                      {plan.label}
                      {plan.total !== null
                        ? ` · ${money.format(plan.total)}`
                        : quote
                          ? " · indisponível"
                          : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="checkout-coupon">
                <label>
                  Cupom de desconto
                  <div>
                    <input
                      value={couponDraft}
                      onChange={(event) => setCouponDraft(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
                      placeholder="Digite o código"
                      maxLength={40}
                    />
                    <button type="button" className="secondary-button" disabled={quoting || !couponDraft} onClick={() => requestQuote(quote?.paymentPlan.code, couponDraft)}>
                      {quoting ? <LoaderCircle className="spin" /> : "Aplicar"}
                    </button>
                  </div>
                </label>
                {quote?.coupon && <p><BadgePercent size={17} /><span><strong>{quote.coupon.code}</strong> · {quote.coupon.description}</span><b>- {money.format(quote.coupon.discountAmount)}</b><button type="button" onClick={() => { setCouponDraft(""); void requestQuote(quote.paymentPlan.code, "") }} aria-label="Remover cupom"><X size={15} /></button></p>}
              </div>
              <div
                className={`checkout-credit ${checkoutTotal > commercialConditions.availableCredit ? "exceeded" : ""}`}
              >
                <span>Crédito disponível</span>
                <strong>
                  {money.format(commercialConditions.availableCredit)}
                </strong>
                {commercialConditions.availableCredit <
                  commercialConditions.creditLimit && (
                  <small>
                    Limite de {money.format(commercialConditions.creditLimit)},
                    com{" "}
                    {money.format(
                      commercialConditions.creditLimit -
                        commercialConditions.availableCredit,
                    )}{" "}
                    comprometidos em títulos e pedidos em aberto.
                  </small>
                )}
                <small>
                  {checkoutTotal > commercialConditions.availableCredit
                    ? `Reduza o pedido em ${money.format(checkoutTotal - commercialConditions.availableCredit)}.`
                    : `Após este pedido: ${money.format(commercialConditions.availableCredit - checkoutTotal)}`}
                </small>
              </div>
              <label>
                Observações
                <textarea
                  name="notes"
                  placeholder="Ex.: melhor horário para entrega, nome de quem vai receber."
                  rows={3}
                />
              </label>
              {orderError && <span className="field-error">{orderError}</span>}
              <div className="checkout-total">
                {quote?.coupon && <small>Subtotal {money.format(quote.subtotal)} · desconto {money.format(quote.coupon.discountAmount)}</small>}
                <span>Total no plano escolhido</span>
                <strong>
                  {quoting ? (
                    <LoaderCircle className="spin" />
                  ) : (
                    money.format(checkoutTotal)
                  )}
                </strong>
              </div>
              <button
                className="checkout-button"
                type="submit"
                disabled={
                  sendingOrder ||
                  quoting ||
                  !quote ||
                  (quote?.subtotal ?? checkoutTotal) < minimumOrder ||
                  checkoutTotal > commercialConditions.availableCredit ||
                  commercialConditions.paymentPlans.length === 0
                }
              >
                {sendingOrder ? (
                  <LoaderCircle className="spin" />
                ) : (
                  <>
                    Enviar pedido <ArrowRight size={19} />
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      )}

      {orderNumber && (
        <div className="overlay modal-overlay">
          <div className="success-modal">
            <span>
              <PackageCheck />
            </span>
            <h2>Pedido recebido!</h2>
            <p>
              Seu pedido <strong>{orderNumber}</strong> foi recebido. Nossa
              equipe comercial vai conferir e dar andamento.
            </p>
            <a className="primary-button" href="/pedidos">
              Ver meus pedidos
            </a>
            <button
              className="secondary-button"
              onClick={() => setOrderNumber("")}
            >
              Continuar comprando
            </button>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast">
          <PackageCheck size={19} />
          {toast}
        </div>
      )}
    </div>
  );
}

function CartQuantityField({
  item,
  onChange,
  onInvalid,
  disabled = false,
}: {
  item: CartItem;
  onChange: (id: number, quantity: number) => Promise<boolean>;
  onInvalid: (message: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(item.quantity));
  useEffect(() => setDraft(String(item.quantity)), [item.quantity]);

  async function commit() {
    const quantity = Number(draft);
    const multiple = Math.max(1, item.salesMultiple);
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < multiple ||
      quantity > 100000 ||
      quantity % multiple !== 0
    ) {
      setDraft(String(item.quantity));
      onInvalid(
        `Digite uma quantidade entre ${multiple} e 100.000, em múltiplos de ${multiple}.`,
      );
      return;
    }
    setDraft(String(quantity));
    if (!(await onChange(item.id, quantity))) setDraft(String(item.quantity));
  }

  return (
    <label
      className="cart-quantity-field"
      aria-label={`Quantidade de ${item.name}`}
    >
      <input
        type="text"
        inputMode="numeric"
        disabled={disabled}
        value={draft}
        onChange={(event) =>
          setDraft(event.target.value.replace(/\D/g, "").slice(0, 6))
        }
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <span>un.</span>
    </label>
  );
}

function ProductCard({
  product,
  rank,
  addToCart,
  changeQuantity,
  setQuantity,
  toggleFavorite,
  favorite,
  quantity,
  authenticated,
  canOrder,
  commercialBlocked,
  checkingStock,
  campaignQuantities,
  onInvalid,
}: {
  product: Product;
  rank?: number;
  addToCart: (product: Product) => Promise<void>;
  changeQuantity: (id: number, delta: number) => Promise<boolean>;
  setQuantity: (id: number, quantity: number) => Promise<boolean>;
  toggleFavorite: (product: Product) => void;
  favorite: boolean;
  quantity: number;
  authenticated: boolean;
  canOrder: boolean;
  commercialBlocked: boolean;
  checkingStock: boolean;
  campaignQuantities: ReadonlyMap<number, number>;
  onInvalid: (message: string) => void;
}) {
  const campaignPrice = productPriceForQuantity(
    product,
    quantity,
    campaignQuantities,
  );
  const nextOffer = [...(product.campaignOffers || [])].sort(
    (a, b) => b.discountPercent - a.discountPercent,
  )[0];
  return (
    <article className="product-card">
      <div className="product-image-wrap">
        {rank && rank <= 10 && (
          <span className="product-badge">#{rank} em vendas</span>
        )}
        <button
          type="button"
          className={`favorite ${favorite ? "active" : ""}`}
          onClick={() => toggleFavorite(product)}
          aria-label={
            favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"
          }
          title={favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"}
        >
          <Heart size={19} fill={favorite ? "currentColor" : "none"} />
        </button>
        <a
          className="product-image-link"
          href={`/produto/${product.code}`}
          aria-label={`Ver detalhes de ${product.name}`}
        >
          {product.image ? (
            <img src={product.image} alt={product.name} />
          ) : (
            <div className="no-product-image">
              <ImageOff />
              <span>Produto sem foto</span>
            </div>
          )}
        </a>
      </div>
      <div className="product-content">
        <span className="product-brand">
          {product.brand} · cód. {product.code}
        </span>
        <h3>
          <a href={`/produto/${product.code}`}>{product.name}</a>
        </h3>
        {nextOffer && (
          <span className="product-campaign-offer">
            {nextOffer.discountPercent.toLocaleString("pt-BR")}% a partir de{" "}
            {nextOffer.minQuantity} un.
          </span>
        )}
        {authenticated && product.unitPrice !== null && (
          <div className="price-row unit-price-row">
            <div>
              {campaignPrice.discountPercent > 0 && (
                <del>{unitMoney.format(product.unitPrice)}</del>
              )}
              <strong>
                {unitMoney.format(campaignPrice.unitPrice ?? product.unitPrice)}
              </strong>
              <small>por unidade</small>
            </div>
          </div>
        )}
        {authenticated && product.unitPrice === null ? (
          <button className="buy-button login-to-buy" disabled>
            Preço indisponível
          </button>
        ) : quantity > 0 && authenticated && canOrder ? (
          <div className="product-quantity-control">
            <button
              disabled={checkingStock}
              onClick={() => changeQuantity(product.id, -product.salesMultiple)}
              aria-label={`Remover ${product.salesMultiple} unidades`}
            >
              <Minus size={18} />
            </button>
            <CartQuantityField
              item={{ ...product, quantity }}
              onChange={setQuantity}
              onInvalid={onInvalid}
              disabled={checkingStock}
            />
            <button
              disabled={checkingStock}
              onClick={() => changeQuantity(product.id, product.salesMultiple)}
              aria-label={`Adicionar ${product.salesMultiple} unidades`}
            >
              <Plus size={18} />
            </button>
          </div>
        ) : (
          <button
            disabled={checkingStock}
            className={`buy-button ${!authenticated || !canOrder ? "login-to-buy" : ""}`}
            onClick={() => addToCart(product)}
          >
            {checkingStock ? (
              <>
                <LoaderCircle className="spin" size={17} />
                Validando estoque
              </>
            ) : !authenticated ? (
              <>
                <LockKeyhole size={17} />
                Entrar para ver preço
              </>
            ) : !canOrder ? (
              <>
                <LoaderCircle size={17} />
                {commercialBlocked ? "Compra bloqueada" : "Cadastro em análise"}
              </>
            ) : (
              <>
                <ShoppingCart size={18} />
                Adicionar {product.salesMultiple}{" "}
                {product.salesMultiple === 1 ? "unidade" : "unidades"}
              </>
            )}
          </button>
        )}
      </div>
    </article>
  );
}

export default App;
